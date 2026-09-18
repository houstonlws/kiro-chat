# Kiro Chat

Unofficial VS Code sidebar chat for [`kiro-cli`](https://kiro.dev/docs/cli/acp/) over ACP.

Open a workspace, talk to Kiro in a chat panel, and review the files it changes — without installing the Kiro IDE. The layout follows that chat (landing, sessions, markdown, tool calls). It is not a substitute for the official IDE and does not use Kiro’s mascot or brand artwork.

## Features

- Optional landing workflows: **Spec**, **Plan**, **Bug Fix**, **Quick Spec** (they pick an agent; they do not start a turn)
- Markdown replies, collapsible tool calls, and diffs
- File review tray with **Keep** / **Undo** (and Keep all / Undo all) plus editor highlights
- Session tabs and history, scoped to the current workspace
- **Autopilot** to auto-approve tool calls, or permission prompts when it is off
- **Add to Kiro Chat** from Explorer and the editor (file or selection)
- Follows your VS Code color theme

## Requirements

- [Kiro CLI](https://kiro.dev/docs/cli/setup/) installed and logged in (`kiro-cli login`)
- [VS Code](https://code.visualstudio.com/) 1.90 or later

Node.js is only needed if you build from source.

## Install

This extension is not on the Marketplace yet. Build it locally, then either run it in the Extension Development Host or install a VSIX.

Clone this repository, then:

```bash
npm install
npm run compile
```

- **Run locally:** open this folder in VS Code, then **Run Extension** (F5). In the new window, open a workspace folder.
- **Install:** `npx @vscode/vsce package`, then in VS Code **Extensions: Install from VSIX…** and pick the generated `.vsix`.

Open the **Kiro Chat** view in the Activity Bar, or press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS).

## How to use

1. Open a workspace folder (sessions are tied to that folder).
2. Optionally click **Spec**, **Plan**, **Bug Fix**, or **Quick Spec** on the landing page.
3. Type a message and send.

The hamburger menu opens **Active Sessions** and **Session History**. Toggle **Autopilot** in the composer: off, Kiro asks before making changes; on, tool calls are approved automatically.

When the agent edits files, they appear in the review tray at the bottom of the panel. **Keep** accepts a change; **Undo** restores the snapshot from before that edit. Changed lines are highlighted in the editor.

Right-click a file in Explorer or a selection in the editor to add it to the current chat.

## Settings

All settings are under `kiroChat.*` in VS Code Settings.

| Setting | Purpose |
| --- | --- |
| `cliPath` | Absolute path to `kiro-cli` if it is not on PATH |
| `linuxCliPath` / `osxCliPath` / `windowsCliPath` | OS-specific path overrides |
| `shell` | `auto`, `bash`, `zsh`, `fish`, `pwsh`, `powershell`, `cmd`. On Windows, `bash` is Git Bash (not the WSL System32 shim); `auto` is `pwsh`. |
| `useLoginShell` | Spawn through a login shell so nvm/Homebrew (macOS/Linux) or Git Bash (Windows) PATH works. On Windows this only applies to `bash`, `zsh`, and `fish`. |
| `extraArgs` | Extra args after `kiro-cli acp` |
| `env` | Extra environment variables |
| `cwd` | Working directory (empty = current workspace folder) |
| `logTraffic` | Log ACP JSON to the **Kiro Chat ACP** output channel |

VS Code often does not inherit your login-shell PATH. If the panel cannot connect, set `cliPath` (or the OS-specific override) to the output of `which kiro-cli` / `where kiro-cli`, then run **Kiro Chat: Restart CLI**. Turn on `logTraffic` and check the **Kiro Chat ACP** output channel if you need to see the JSON-RPC traffic.

## Commands

- **Kiro Chat: Open** (`Ctrl+Alt+K` / `Cmd+Alt+K`)
- **Kiro Chat: New Session**
- **Kiro Chat: Session List**
- **Kiro Chat: Cancel Turn**
- **Kiro Chat: Restart CLI**
- Explorer: **Add to Kiro Chat**
- Editor: **Add File to Kiro Chat** / **Add Selection to Kiro Chat**

## Develop

```bash
npm install
npm run compile   # or npm run watch
```

Open this folder in VS Code and press **F5** / **Run Extension**. Changes to `src/` need a compile (or the watch task) and a reload of the Extension Development Host.
