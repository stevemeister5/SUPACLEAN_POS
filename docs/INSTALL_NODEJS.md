# Installing Node.js - Quick Guide

## Step 1: Download Node.js

1. Go to: **https://nodejs.org/**
2. Download the **LTS version** (recommended for most users)
   - Click the big green button that says "LTS" (Long Term Support)
   - This will download an installer file (e.g., `node-v20.x.x-x64.msi`)

## Step 2: Install Node.js

1. **Run the installer** you just downloaded
2. **Follow the installation wizard:**
   - Click "Next" through the setup
   - Accept the license agreement
   - **IMPORTANT:** Make sure "Add to PATH" option is checked (it usually is by default)
   - Choose the default installation location
   - Click "Install"
   - Wait for installation to complete
   - Click "Finish"

## Step 3: Verify Installation

1. **Close and reopen** your terminal/command prompt (or restart Cursor)
2. Run these commands to verify:

```bash
node --version
npm --version
```

You should see version numbers (e.g., `v20.10.0` and `10.2.3`)

## Step 4: After Installing Node.js

Once Node.js is installed, come back here and we'll continue with testing!

## Alternative: Using Chocolatey (if you have it)

If you have Chocolatey package manager installed, you can run:
```powershell
choco install nodejs-lts
```

---

**After installing Node.js, let me know and we'll continue testing the POS system!** 🚀
*You seem to be using an outdated version of Cursor. Please upgrade to the latest version by [downloading Cursor again from our website](https://www.cursor.com/). All your settings will be preserved.*
