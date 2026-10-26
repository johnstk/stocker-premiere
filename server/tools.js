"use strict";
const { MARKER_COLORS } = require("../panel/lib/cores");

const VERSION = "0.2.0";

const sequence = { type: "string", description: "Nome da sequência; omita para a ativa." };
const time = { type: ["number", "string"], description: 'Segundos na timeline (ou timecode "HH:MM:SS:FF").' };
const clipRef = {
  type: "object",
  description: 'Clipe da timeline: {track:"V1", clip:2} (1-based), {track:"V1", clip:"nome"} ou {track:"V1", time:12.5}.',
  properties: { track: { type: "string" }, clip: { type: ["integer", "string"] }, time },
  required: ["track"],
};
const clips = { type: "array", items: clipRef, description: "Um ou mais clipes." };
const itemRef = { type: ["string", "object"], description: 'Item do projeto: nome, caminho "Bin/Nome", {nodeId} ou {mediaPath}.' };
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function t(name, title, description, properties, hints, required) {
  const inputSchema = { type: "object", properties };
  if (required) inputSchema.required = required;
  return { name, description, inputSchema, annotations: { title, ...hints } };
}

const TOOLS = [
  t("pr_status", "Estado da ponte", "Diz se o Premiere e o painel Stocker Premiere estão conectados, as versões e o projeto aberto.", {}, RO),
  t("pr_getProjectState", "Ler projeto", "Lista bins e itens do projeto (nome, tipo bin/clip/sequence, bin, caminho da mídia, nodeId) e as sequências. Chame antes de citar itens.",
    { bin: { type: "string", description: "Só este bin (caminho)." }, depth: { type: "integer" }, maxItems: { type: "integer" } }, RO),
  t("pr_getSequenceState", "Ler sequência", "Lê fps, tamanho, duração, playhead, cada trilha com seus clipes (número 1-based, nome, início/fim, in/out da fonte, desligado, mídia) e os marcadores. Chame antes e depois de editar.",
    { sequence, tracks: { type: "string", enum: ["all", "video", "audio"] }, from: time, to: time, maxClips: { type: "integer" }, detail: { type: "boolean", description: "Inclui o caminho da mídia de cada clipe (já vem sempre)." } }, RO),
  t("pr_importFiles", "Importar mídia", "Importa arquivos (caminhos absolutos) para um bin (criado se faltar). Nunca apaga nada.",
    { paths: { type: "array", items: { type: "string" } }, bin: { type: "string" } }, ADD, ["paths"]),
  t("pr_createSequence", "Criar sequência", "Cria uma sequência a partir de itens (configuração do primeiro) e abre. empty:true tira os clipes, deixando a sequência vazia com a configuração certa.",
    { name: { type: "string" }, fromItems: { type: "array", items: itemRef }, empty: { type: "boolean" }, bin: { type: "string" } }, ADD, ["name", "fromItems"]),
  t("pr_duplicateSequence", "Duplicar sequência", "Duplica uma sequência (e abre a cópia). Faça isso antes de edição grande.",
    { sequence, name: { type: "string" }, open: { type: "boolean" } }, ADD),
  t("pr_saveProject", "Salvar projeto", "Salva o projeto. Só quando o usuário pedir.", {}, ADD),
  t("pr_placeClip", "Colocar clipe", "Põe um item numa trilha de vídeo num tempo (overwrite, ou insert). sourceIn/sourceOut usam só um trecho. O áudio vai para a trilha de mesmo número (audioTrack muda; null = só vídeo). Relê e devolve verificado.",
    { item: itemRef, sequence, track: { type: "string" }, time, sourceIn: time, sourceOut: time, mode: { type: "string", enum: ["overwrite", "insert"] }, audioTrack: { type: ["string", "null"] } }, EDIT, ["item", "time"]),
  t("pr_setClipEnabled", "Ligar/desligar clipes", "Liga ou desliga clipes (desligado fica na timeline mas não toca).",
    { sequence, clips, enabled: { type: "boolean" } }, EDIT, ["clips", "enabled"]),
  t("pr_addMarkers", "Adicionar marcadores", `Adiciona marcadores de sequência numa chamada: [{time, name, comment, duration, color}]. Cores: ${MARKER_COLORS.join(", ")}.`,
    { sequence, markers: { type: "array", items: { type: "object", properties: { time, name: { type: "string" }, comment: { type: "string" }, duration: { type: "number" }, color: { type: "string", enum: MARKER_COLORS } }, required: ["time"] } } }, ADD, ["markers"]),
  t("pr_applyEditPlan", "Plano de edição", "Roda vários passos pr_* numa chamada, em ordem: steps:[{tool, input}]. Para no primeiro erro, salvo stopOnError:false. Não aceita salvar nem exportar.",
    { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool"] } }, stopOnError: { type: "boolean" } }, EDIT, ["steps"]),
  t("pr_setClipProperties", "Escala/posição/rotação/opacidade", "Muda Movimento/Opacidade dos clipes por matchName (funciona com o Premiere em português): scale %, position [x,y] em pixels (0,0 no canto superior esquerdo), rotation em graus, opacity 0-100. Animação: keyframes:[{time, scale?, position?, rotation?, opacity?}] em segundos da timeline.",
    { sequence, clips, scale: { type: "number" }, position: { type: "array", items: { type: "number" } }, rotation: { type: "number" }, opacity: { type: "number" }, keyframes: { type: "array", items: { type: "object" } } }, EDIT, ["clips"]),
  t("pr_findEffects", "Procurar efeitos", "Procura efeitos e transições instalados por matchName ou nome exibido. Use para achar o matchName antes de pr_applyEffect.",
    { query: { type: "string" }, kind: { type: "string", enum: ["videoEffect", "videoTransition"] }, max: { type: "integer" } }, RO),
  t("pr_applyEffect", "Aplicar efeito", "Aplica um efeito de vídeo aos clipes. effect = matchName (ex.: 'ADBE Gaussian Blur 2', 'ADBE Lumetri') ou o nome exibido exato.",
    { sequence, clips, effect: { type: "string" } }, EDIT, ["clips", "effect"]),
  t("pr_setEffectProperties", "Ajustar efeito", "Muda parâmetros de um efeito já aplicado (ou de 'ADBE Motion'/'ADBE Opacity'). effect = matchName; occurrence escolhe qual, se houver vários. params: {'#11': 80} por índice (recomendado) ou {'Intensidade': 80} pelo nome exibido.",
    { sequence, clips, effect: { type: "string" }, occurrence: { type: "integer" }, params: { type: "object" } }, EDIT, ["clips", "effect", "params"]),
  t("pr_getInputLut", "Ler LUT de entrada", "Lê o ID da LUT de entrada (e da LUT embutida) de itens de mídia do projeto. Use num clipe que o usuário já configurou para copiar o ID.",
    { items: { type: "array", items: itemRef } }, RO, ["items"]),
  t("pr_setInputLut", "Aplicar LUT de entrada", "Aplica uma LUT de entrada (pelo ID lido com pr_getInputLut) a itens de mídia do projeto; lutId null tira a LUT.",
    { items: { type: "array", items: itemRef }, lutId: { type: ["string", "null"] } }, EDIT, ["items", "lutId"]),
  t("pr_copyEffect", "Copiar efeito (colar atributos)", "Copia um efeito inteiro, todos os parâmetros, de um clipe para outros, como o Colar atributos do Premiere. Feito para a cor: o Lumetri leva a LUT de entrada, o look e os ajustes, que não atravessam o XML. from = clipe de origem {sequence, track, clip|time} (pode ser de outra sequência); clips = destinos na sequence. Se o destino não tem o efeito, ele é adicionado; se tem, é sobrescrito. effect padrão 'ADBE Lumetri'. Relê e devolve verificado, com os parâmetros que o Premiere recusou.",
    { from: { type: "object", description: "Clipe de origem: {sequence, track, clip} ou {sequence, track, time}.", properties: { sequence, track: { type: "string" }, clip: { type: ["integer", "string"] }, time }, required: ["track"] }, sequence, clips, effect: { type: "string" }, occurrence: { type: "integer" } }, EDIT, ["from", "clips"]),
  t("pr_exportFrame", "Ver um quadro", "Renderiza o quadro num tempo (padrão: playhead) e devolve a imagem (PNG, 1280 px de largura por padrão). Use depois de mudanças visuais.",
    { sequence, time, width: { type: "integer" }, height: { type: "integer" } }, RO),
  t("pr_exportSequence", "Exportar vídeo", "Exporta a sequência com um preset (.epr): modo 'agora' (renderiza no Premiere) ou 'fila_ame' (manda para o Media Encoder). Só com aprovação explícita do usuário: exige confirmado:true.",
    { sequence, outputPath: { type: "string" }, preset: { type: "string" }, modo: { type: "string", enum: ["agora", "fila_ame"] }, inteira: { type: "boolean" }, confirmado: { type: "boolean" } }, EDIT, ["outputPath", "preset", "confirmado"]),
];

const TOOL_NAMES = new Set(TOOLS.map((x) => x.name));
const EDIT_PLAN_ALLOWED = new Set(["pr_getProjectState", "pr_getSequenceState", "pr_importFiles", "pr_createSequence", "pr_duplicateSequence",
  "pr_placeClip", "pr_setClipEnabled", "pr_addMarkers", "pr_setClipProperties", "pr_applyEffect", "pr_setEffectProperties", "pr_setInputLut", "pr_copyEffect"]);
const TIMEOUTS = { pr_importFiles: 300000, pr_createSequence: 120000, pr_duplicateSequence: 120000, pr_exportSequence: 3600000 };
function timeoutFor(name) { return TIMEOUTS[name] || 90000; }

const INSTRUCTIONS = `stocker-premiere liga o Claude ao Premiere Pro do usuário (painel UXP local, sem nuvem). Tudo cai no projeto real:
1. Leia antes: pr_getSequenceState (e pr_getProjectState antes de citar itens). Números de clipe mudam depois de editar; releia.
2. Antes de edição grande, pr_duplicateSequence e trabalhe na cópia, salvo pedido contrário.
3. Nunca apague mídia do projeto.
4. Tempos em segundos na timeline; trilhas V1/V2/A1/A2.
5. Efeitos e parâmetros por matchName ('ADBE Motion', 'ADBE Lumetri') ou por índice '#n'. Não dependa do nome exibido: ele muda com o idioma do Premiere.
6. Junte passos com pr_applyEditPlan; confira o visual com pr_exportFrame.
7. pr_saveProject e pr_exportSequence só com pedido explícito do usuário (o export exige confirmado:true).
8. Cada passo lógico vira um ou mais passos de desfazer no Premiere (colocar um trecho usa 3). Diga o que mudou.`;

module.exports = { VERSION, TOOLS, TOOL_NAMES, EDIT_PLAN_ALLOWED, timeoutFor, INSTRUCTIONS };
