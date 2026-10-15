const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const isR2Configured = Boolean(
  process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

let r2Client = null;

if (isR2Configured) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

/**
 * Test connectivity with Cloudflare R2
 */
async function testR2Connection() {
  if (!r2Client) {
    return { configured: false, error: 'Cloudflare R2 credentials not configured.' };
  }
  try {
    const cmd = new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME });
    await r2Client.send(cmd);
    return { configured: true, connected: true, bucket: process.env.R2_BUCKET_NAME };
  } catch (err) {
    return { configured: true, connected: false, error: err.message };
  }
}

/**
 * Upload buffer or stream directly to Cloudflare R2
 */
async function uploadToR2(key, fileBuffer, contentType) {
  if (!r2Client) {
    throw new Error('R2 Client is not configured.');
  }

  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType
  });

  await r2Client.send(cmd);
  const publicEndpoint = process.env.R2_PUBLIC_DOMAIN || `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}`;
  return {
    key,
    bucket: process.env.R2_BUCKET_NAME,
    url: `${publicEndpoint}/${key}`
  };
}

/**
 * Generate a presigned PUT URL for direct client-to-R2 upload
 */
async function getR2PresignedUploadUrl(key, contentType, expiresInSeconds = 3600) {
  if (!r2Client) {
    throw new Error('R2 Client is not configured.');
  }

  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType
  });

  const uploadUrl = await getSignedUrl(r2Client, cmd, { expiresIn: expiresInSeconds });
  const publicEndpoint = process.env.R2_PUBLIC_DOMAIN || `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}`;

  return {
    uploadUrl,
    key,
    publicUrl: `${publicEndpoint}/${key}`,
    expiresInSeconds
  };
}

/**
 * Delete an object from Cloudflare R2
 */
async function deleteFromR2(key) {
  if (!r2Client) return { success: false, error: 'R2 not configured' };

  try {
    const cmd = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    });
    await r2Client.send(cmd);
    return { success: true };
  } catch (err) {
    console.error(`Error deleting ${key} from R2:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isR2Configured,
  r2Client,
  testR2Connection,
  uploadToR2,
  getR2PresignedUploadUrl,
  deleteFromR2
};
