# Preferred Setup

Chrome opens one window and piles your tabs together. Preferred Setup puts each window back on the monitor you left it on, with that window's own tabs.

It runs on Windows (and anywhere else Chrome runs). It uses however many monitors the system reports — one, four, or more. Layouts stay on your machine. Nothing is uploaded.

## How other people install it

From the Chrome Web Store. Chrome reviews the extension, shows the permissions, and the person clicks Add. They do not turn on developer mode, and they do not install a zip from a stranger.

This folder is the package you upload to the store. It is not something to forward.

Until that listing exists, only the author should load it for testing:

1. Unzip this folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder.

## After it is installed

1. Arrange your Chrome windows the way you want them.
2. Click the Preferred Setup icon and choose **Save this arrangement**.

The next time Chrome starts, a short “Deploying your preferred setup” screen appears, then your windows open where you saved them.

You can leave Chrome’s own startup setting however you like (including “Open a specific page or set of pages”). The extension replaces that single piled window.

## Update the setup

Move windows, open or close tabs, then click **Update preferred setup**.

## Advanced

Open the Advanced switch for:

- Tab groups, including names and colors
- Per-tab zoom
- Extra named layouts (only the selected one restores on startup)
- Export and import as JSON, so you can back up or move a setup to another computer

If a monitor is unplugged, windows that lived on it open in the center of another monitor so you can drag them and save again.

## Permissions

- **Tabs** — so the saved setup can include the page address of each tab
- **Tab groups** — so group names and colors can be restored
- **Displays** — so windows land on the monitors you actually have
- **Windows** — so each window opens where you left it
- **Storage** — so the layout stays on that computer

There is no account and no network request. The privacy page for the store listing lives with the product site.
