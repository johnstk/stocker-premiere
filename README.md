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

Use one of the two, not both: the session would get every tool twice.

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

## Several Claude sessions at once

Two or more Claude Code sessions can edit in the same Premiere (for example, one cutting a teaser and
another a Reel). The panel does not change:

- The first session that opens port 47321 becomes the **owner** and talks to the panel. The others
  join as **clients** of the owner, over the same local WebSocket and with the same token.
- The owner queues every command from every session and sends them to the panel one at a time.
  A `pr_applyEditPlan` runs whole: no command from another session lands in the middle of it.
- When the owner session closes, one of the clients takes over the port and the panel reconnects
  to it by itself (about 2 s). A command that was in flight at that moment returns `nao_conectado`;
  re-read the sequence before repeating it.
- With two or more sessions connected, tools that change a sequence (`pr_placeClip`,
  `pr_setClipProperties`, `pr_applyEffect`, `pr_addMarkers`, `pr_duplicateSequence`,
  `pr_exportSequence` and the like) **require `sequence`**. Without it they would act on the active
  sequence, which may be the one another session is working on. Reads still work without it.
- `pr_status` shows `sessoes` (how many sessions are connected), `papel` (`dona` or `cliente`) and
  `fila` (commands waiting).

Sessions that were already open keep running the old code until they are restarted. A session on
the old code that owns the port does not accept clients: new sessions get `ponte_ocupada` and must
wait for it to be restarted or closed.

## Development

- Tests: `npm test`
- Call one tool live, without Claude (joins an open session as a client if there is one): `node smoke/run.js pr_status`
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

**Várias sessões ao mesmo tempo:** a primeira sessão do Claude que abre a porta 47321 vira a dona e
fala com o painel; as outras entram como clientes dela. A dona põe os comandos de todas numa fila e
manda um por vez; um `pr_applyEditPlan` roda inteiro, sem comando de outra sessão no meio. Se a dona
fechar, uma das outras assume e o painel reconecta sozinho em uns 2 s (o comando que estava no meio
volta `nao_conectado`: releia antes de repetir). Com duas sessões ou mais, as tools que editam exigem
`sequence`, para não cair na sequência ativa de outra sessão. `pr_status` mostra `sessoes`, `papel`
(`dona` ou `cliente`) e `fila`. Sessões abertas antes da atualização só pegam o código novo quando
forem reiniciadas; enquanto uma delas for a dona, as novas recebem `ponte_ocupada`.

Exportar vídeo exige `confirmado: true`. Ainda não tem razor, trim,
mover/remover clipe, transições, gráficos, legendas, bins nem abrir sequência.

Licença MIT © 2026 Stocker Films.
