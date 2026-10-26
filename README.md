# stocker-premiere

Edit Adobe Premiere Pro from Claude Code. A local MCP server plus a Premiere UXP panel expose `pr_*`
tools: read projects and sequences, duplicate and create sequences, import media, place clips, add
markers, enable or disable clips, set scale, position, rotation and opacity (with keyframes), apply and
tweak effects, copy a whole effect between clips (e.g. a Lumetri grade with its LUT and look), copy input LUTs, export frames and videos, and run whole edit plans in one batch.

```
Claude Code ─stdio─> MCP server ─WebSocket 127.0.0.1:47321 (token)─> UXP panel ─> premierepro API
```

Everything runs on your machine. The panel only accepts connections from localhost with the token
created on first run.

*Versão em português abaixo.*

## Requirements

- macOS with Premiere Pro 26.3 or newer (tested on 26.5.2)
- Node.js 22 or newer
- Claude Code

## Install

### 1. The Premiere panel

Download the `.ccx` from the latest [release](https://github.com/johnstk/stocker-premiere/releases)
and, with Premiere closed, run:

```bash
"/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install ~/Downloads/com.stockerfilms.premiere.ponte_premierepro.ccx
```

(Double-clicking the `.ccx` may also work through Creative Cloud.)

### 2. The MCP server

**As a Claude Code plugin (recommended).** In Claude Code:

```
/plugin marketplace add johnstk/stocker-premiere
/plugin install stocker-premiere@stocker-films
```

This also installs the `premiere-edit` skill, which teaches Claude the safe way to use the tools.
Dependencies are installed on first start.

**Or by hand:**

```bash
git clone https://github.com/johnstk/stocker-premiere.git ~/.claude/mcp-servers/stocker-premiere
cd ~/.claude/mcp-servers/stocker-premiere && npm install
claude mcp add --scope user stocker-premiere -- node ~/.claude/mcp-servers/stocker-premiere/server/index.js
```

Use one of the two, not both: they would fight over port 47321.

### 3. Connect

1. Open Premiere and the panel: **Window › UXP Plugins › Stocker Premiere**.
2. Start a new Claude Code session (the server starts with it and creates the token).
3. Paste into the panel the token from `~/Library/Application Support/stocker-premiere/token`
   (`cat` that file). The panel remembers it.
4. Ask Claude to run `pr_status`. It should answer with your project's name.

## Tools

`pr_status`, `pr_getProjectState`, `pr_getSequenceState`, `pr_duplicateSequence`, `pr_createSequence`,
`pr_importFiles`, `pr_placeClip`, `pr_addMarkers`, `pr_setClipEnabled`, `pr_setClipProperties`,
`pr_findEffects`, `pr_applyEffect`, `pr_setEffectProperties`, `pr_copyEffect`, `pr_getInputLut`, `pr_setInputLut`,
`pr_exportFrame`, `pr_exportSequence` (needs `confirmado: true`), `pr_saveProject`, `pr_applyEditPlan`
(batch; stops at the first step that fails or does not verify).

Not available yet: razor, trim, moving or removing clips, removing a range, transitions, graphics,
captions, bins, opening a sequence. There is deliberately no tool that deletes sequences or project items.

Only one Claude session can use the panel at a time.

## Development

- Tests: `npm test`
- Call one tool live, without Claude (stop the MCP first, both use port 47321): `node smoke/run.js pr_status`
- Rebuilding the panel: in Adobe UXP Developer Tools, Add Plugin → `panel/manifest.json`, then
  ••• › Package. Install the new `.ccx` as above and restart Premiere. Bump the version in
  `panel/manifest.json` and attach the `.ccx` to a new release.

## License

MIT © 2026 Stocker Films

---

## Português

Edite o Adobe Premiere Pro pelo Claude Code. Um servidor MCP local e um painel UXP no Premiere oferecem
as ferramentas `pr_*`: ler projeto e sequências, duplicar e criar sequências, importar mídia, colocar
clipes, marcadores, ligar e desligar clipes, escala, posição, rotação e opacidade (com keyframes),
efeitos, copiar um efeito inteiro entre clipes (o Lumetri com LUT e look), LUT de entrada, exportar quadro e vídeo, e rodar um plano de edição inteiro em lote.

**Requisitos:** macOS com Premiere Pro 26.3 ou mais novo (testado no 26.5.2), Node 22 ou mais novo, Claude Code.

**Instalar:**

1. Painel: baixe o `.ccx` em [Releases](https://github.com/johnstk/stocker-premiere/releases) e, com o
   Premiere fechado, rode o comando `UnifiedPluginInstallerAgent --install` mostrado acima.
2. Servidor, como plugin do Claude Code (recomendado):
   `/plugin marketplace add johnstk/stocker-premiere` e depois `/plugin install stocker-premiere@stocker-films`.
   Ou à mão: clone, `npm install` e `claude mcp add` como acima. Use um dos dois, não os dois.
3. Abra o painel em **Janela › Plug-ins UXP › Stocker Premiere**, abra uma sessão nova do Claude Code,
   cole no painel o token de `~/Library/Application Support/stocker-premiere/token` e peça `pr_status`.

Uma sessão do Claude por vez. Exportar vídeo exige `confirmado: true`. Ainda não tem razor, trim,
mover/remover clipe, transições, gráficos, legendas, bins nem abrir sequência.

Licença MIT © 2026 Stocker Films.
