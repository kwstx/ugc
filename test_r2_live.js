const { testR2Connection, uploadToR2, deleteFromR2 } = require('./services/r2Client');

async function run() {
  console.log('Testing Cloudflare R2 connectivity with your credentials...');
  const conn = await testR2Connection();
  console.log('Connection test result:', conn);

  if (conn.connected) {
    console.log('Successfully authenticated to Cloudflare R2 bucket:', conn.bucket);

    // Test a small test upload
    const testKey = `test-ping-${Date.now()}.txt`;
    console.log(`Uploading test file "${testKey}" to R2...`);
    const uploadRes = await uploadToR2(testKey, Buffer.from('Cloudflare R2 ping test for Sofia'), 'text/plain');
    console.log('Upload to R2 successful:', uploadRes);

    // Clean up test file
    console.log('Cleaning up test file from R2...');
    const delRes = await deleteFromR2(testKey);
    console.log('Cleanup from R2 result:', delRes);
    console.log('\n===========================================');
    console.log('CLOUDFLARE R2 BUCKET IS 100% OPERATIONAL!');
    console.log('===========================================\n');
  } else {
    console.error('Connection failed:', conn.error);
  }
}

run();
