# stocker-premiere

Ponte local entre o Claude Code e o Premiere Pro 26.x da Stocker Films.
Servidor MCP (stdio) + painel UXP "Stocker Premiere". Contrato `pr_*` compatível com o Filmit.

```
Claude Code ─stdio─> server/index.js ─WebSocket 127.0.0.1:47321 (token)─> painel UXP ─> API premierepro
```

## Requisitos

- macOS com Premiere Pro 26.3 ou mais novo (testado no 26.5.2)
- Node 22 ou mais novo
- Claude Code

## Instalar

1. Clonar e instalar as dependências:

   ```bash
   git clone https://github.com/johnstk/stocker-premiere.git ~/.claude/mcp-servers/stocker-premiere
   cd ~/.claude/mcp-servers/stocker-premiere && npm install
   ```

2. Instalar o painel no Premiere. Baixe o `.ccx` da última versão em
   [Releases](https://github.com/johnstk/stocker-premiere/releases) e rode, com o Premiere fechado:

   ```bash
   "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install ~/Downloads/com.stockerfilms.premiere.ponte_premierepro.ccx
   ```

   (Dar dois cliques no `.ccx` também pode funcionar, pelo Creative Cloud.)

3. Registrar o MCP no Claude Code:

   ```bash
   claude mcp add --scope user stocker-premiere -- node ~/.claude/mcp-servers/stocker-premiere/server/index.js
   ```

4. Abrir o Premiere e o painel em **Janela › Plug-ins UXP › Stocker Premiere**. Na primeira vez, cole no
   painel o token que o servidor cria em `~/Library/Application Support/stocker-premiere/token`
   (`cat` nesse arquivo). O painel guarda o token.

5. Abrir uma sessão nova do Claude Code e pedir `pr_status`. Se responder com o nome do projeto, está pronto.

## Uso

- Uma sessão do Claude por vez: o servidor ocupa a porta 47321; uma segunda sessão não conecta.
- Tools: `pr_status`, `pr_getProjectState`, `pr_getSequenceState`, `pr_duplicateSequence`,
  `pr_createSequence`, `pr_importFiles`, `pr_placeClip`, `pr_addMarkers`, `pr_setClipEnabled`,
  `pr_setClipProperties`, `pr_findEffects`, `pr_applyEffect`, `pr_setEffectProperties`,
  `pr_getInputLut`, `pr_setInputLut`, `pr_exportFrame`, `pr_exportSequence` (exige `confirmado: true`),
  `pr_saveProject`, `pr_applyEditPlan` (lote; para no primeiro passo que falha ou não confere).
- Ainda não existem: razor, trim, mover/remover clipe, remover trecho, transições, gráficos, legendas,
  bins, abrir sequência.
- Não há ferramenta de apagar sequência ou item do projeto, de propósito.

## Atualizar o painel depois de mudar o código

1. No Adobe UXP Developer Tools: Add Plugin → `panel/manifest.json`, depois ••• › Package.
2. Instalar o `.ccx` gerado com o comando do passo 2 e reiniciar o Premiere.
3. Subir a versão em `panel/manifest.json` e publicar o `.ccx` num Release novo.

## Desenvolvimento

- Testes: `npm test`
- Teste ao vivo de uma tool (com o MCP parado, porque os dois usam a porta 47321):
  `node smoke/run.js pr_status`
