# Privacy Policy — Teams Transcript Exporter

**Last updated: April 11, 2026**

## Overview

Teams Transcript Exporter is a browser extension that exports Microsoft Teams meeting transcripts as `.vtt` files directly within your browser. This privacy policy explains how the extension handles data.

## Data Collection

**This extension does not collect, store, transmit, or share any personal data.**

- No data is sent to any external server
- No analytics or tracking of any kind
- No user accounts or sign-in required
- No cookies are set

## How the Extension Works

When you click "Export Transcript", the extension reads the transcript text already loaded in your browser's memory (via the Teams/SharePoint recording player) and saves it as a `.vtt` file directly to your local device. All processing happens entirely within your browser.

## Permissions

The extension requests the following permissions solely to perform its core function:

| Permission | Reason |
|---|---|
| `activeTab` | Read the current tab to detect the transcript panel |
| `scripting` | Run the transcript extraction on the active Teams/SharePoint page |
| `downloads` | Save the exported `.vtt` file to your device |
| `https://*.sharepoint.com/*` | Access Teams recording pages hosted on SharePoint |
| `https://teams.microsoft.com/*` | Access Teams recording pages hosted on teams.microsoft.com |

## Third Parties

This extension does not integrate with or share data with any third-party services.

## Changes

If this policy changes, the updated version will be published in this repository with a new "Last updated" date.

## Contact

For questions or concerns, open an issue at:
https://github.com/JazzPiece/teams-meeting-buddy/issues
