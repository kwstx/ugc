import subprocess
import time
import json
import urllib.request
import asyncio
import base64
import os
import sys
import websockets

async def capture_timeline():
    chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    user_data = r"C:\Users\galan\ugc\temp_chrome_profile"
    port = 9222

    cmd = [
        chrome_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data}",
        "--headless=new",
        "--disable-gpu",
        "--window-size=1280,800",
        "--hide-scrollbars",
        "file:///c:/Users/galan/ugc/test_letter_anim.html"
    ]

    proc = subprocess.Popen(cmd)
    try:
        time.sleep(1.5)
        # Fetch targets
        req = urllib.request.urlopen(f"http://localhost:{port}/json")
        targets = json.loads(req.read().decode())
        ws_url = targets[0]["webSocketDebuggerUrl"]

        async with websockets.connect(ws_url) as ws:
            # Enable Page and Runtime
            await ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
            await ws.recv()

            async def screenshot(filename):
                msg_id = int(time.time() * 1000) % 100000
                await ws.send(json.dumps({"id": msg_id, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
                while True:
                    resp = json.loads(await ws.recv())
                    if resp.get("id") == msg_id:
                        data = base64.b64decode(resp["result"]["data"])
                        with open(filename, "wb") as f:
                            f.write(data)
                        print(f"Saved {filename}")
                        break

            # Initial capture
            await screenshot(r"C:\Users\galan\ugc\anim_0ms.png")
            await asyncio.sleep(0.4)
            await screenshot(r"C:\Users\galan\ugc\anim_400ms.png")
            await asyncio.sleep(0.4)
            await screenshot(r"C:\Users\galan\ugc\anim_800ms.png")
            await asyncio.sleep(0.6)
            await screenshot(r"C:\Users\galan\ugc\anim_1400ms.png")
            await asyncio.sleep(0.6)
            await screenshot(r"C:\Users\galan\ugc\anim_2000ms.png")

    finally:
        proc.terminate()
        proc.wait()

if __name__ == "__main__":
    asyncio.run(capture_timeline())
