# Privacy Policy — Teams Transcript Exporter

**Last updated: May 24, 2026**

## Overview

Teams Transcript Exporter is a browser extension that exports Microsoft Teams meeting transcripts from SharePoint and Teams recording pages. This policy explains how the extension handles data.

## Data Collection

**This extension does not collect, store, transmit, or share any personal data.**

- No data is sent to any external server
- No analytics or tracking of any kind
- No user accounts or sign-in required
- No cookies are set

## How the Extension Works

When you click Export (or press Alt+Shift+T), the extension reads the transcript data already loaded in your browser's memory via the Teams/SharePoint recording player and saves the result as a local file (VTT, SRT, DOCX, or TXT). All processing happens entirely within your browser. Transcript content never leaves your device.

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Detect the transcript panel on the current tab |
| `scripting` | Inject the extraction script into the Teams/SharePoint page to read transcript data from the React component state |
| `downloads` | Save the exported transcript file to your local device |
| `storage` | Persist user preferences (last-used export format, merge setting) in local browser storage — data never leaves the device |
| `https://*.sharepoint.com/*` | Access Teams recording pages hosted on SharePoint |
| `https://teams.microsoft.com/*` | Access Teams recording pages on teams.microsoft.com |
| `https://*.teams.microsoft.com/*` | Access Teams recording pages on subdomain variants |

## Remote Code

This extension does not load or execute any remote code. All JavaScript is bundled within the extension package.

## Third Parties

This extension does not integrate with or share data with any third-party services.

## Changes

If this policy changes, the updated version will be published in this repository with a new "Last updated" date.

## Contact

For questions or concerns, open an issue at:
https://github.com/JazzPiece/teams-meeting-buddy/issues
