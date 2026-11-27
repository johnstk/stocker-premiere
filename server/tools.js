"use strict";
const { MARKER_COLORS } = require("../panel/lib/cores");

const VERSION = "0.4.0";

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
    { sequence, tracks: { type: "string", description: "all, video, audio ou lista de trilhas (ex.: \"V2,V7\"). Em sequência grande, peça só as trilhas e o trecho (from/to) que precisa." }, from: time, to: time, maxClips: { type: "integer" }, detail: { type: "boolean", description: "false tira o caminho da mídia (mais leve)." }, markers: { type: "boolean", description: "false não lê os marcadores." } }, RO),
  t("pr_importFiles", "Importar mídia", "Importa arquivos (caminhos absolutos) para um bin (criado se faltar). Nunca apaga nada.",
    { paths: { type: "array", items: { type: "string" } }, bin: { type: "string" } }, ADD, ["paths"]),
  t("pr_createSequence", "Criar sequência", "Cria uma sequência a partir de itens (configuração do primeiro) e abre. empty:true tira os clipes, deixando a sequência vazia com a configuração certa.",
    { name: { type: "string" }, fromItems: { type: "array", items: itemRef }, empty: { type: "boolean" }, bin: { type: "string" } }, ADD, ["name", "fromItems"]),
  t("pr_duplicateSequence", "Duplicar sequência", "Duplica uma sequência (e abre a cópia). Faça isso antes de edição grande.",
    { sequence, name: { type: "string" }, open: { type: "boolean" } }, ADD),
  t("pr_saveProject", "Salvar projeto", "Salva o projeto. Só quando o usuário pedir.", {}, ADD),
  t("pr_placeClip", "Colocar clipe", "Põe um item numa trilha de vídeo num tempo (overwrite, ou insert). sourceIn/sourceOut usam só um trecho. O áudio vai para a trilha de mesmo número (audioTrack muda; null = só vídeo). Relê e devolve verificado.",
    { item: itemRef, sequence, track: { type: "string" }, time, sourceIn: time, sourceOut: time, mode: { type: "string", enum: ["overwrite", "insert"] }, audioTrack: { type: ["string", "null"] } }, EDIT, ["item", "time"]),
  t("pr_moveClip", "Mover clipe de trilha", "Move clipes para outra trilha do mesmo tipo (V→V, A→A), no mesmo tempo, levando volume e efeitos: clona na trilha de destino e tira o original. A trilha de destino precisa estar livre no intervalo de cada clipe; os números dos clipes mudam depois, releia com pr_getSequenceState.",
    { sequence, clips, toTrack: { type: "string", description: "Trilha de destino, ex.: A3." } }, EDIT, ["clips", "toTrack"]),
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
  t("pr_applyAudioEffect", "Aplicar efeito de áudio", "Aplica um efeito de áudio pelo nome exibido no Premiere (ex.: 'Simple Parametric EQ', 'Highpass') em clipes de áudio. listar:true devolve os nomes disponíveis. Ajuste os parâmetros depois com pr_setEffectProperties usando o nome exibido.",
    { sequence, clips, effect: { type: "string" }, listar: { type: "boolean" } }, EDIT),
  t("pr_setEffectProperties", "Ajustar efeito", "Muda parâmetros de um efeito já aplicado (ou de 'ADBE Motion'/'ADBE Opacity'). effect = matchName; occurrence escolhe qual, se houver vários. params: {'#11': 80} por índice (recomendado) ou {'Intensidade': 80} pelo nome exibido.",
    { sequence, clips, effect: { type: "string" }, occurrence: { type: "integer" }, params: { type: "object" } }, EDIT, ["clips", "effect", "params"]),
  t("pr_getInputLut", "Ler LUT de entrada", "Lê o ID da LUT de entrada (e da LUT embutida) de itens de mídia do projeto. Use num clipe que o usuário já configurou para copiar o ID.",
    { items: { type: "array", items: itemRef } }, RO, ["items"]),
  t("pr_setInputLut", "Aplicar LUT de entrada", "Aplica uma LUT de entrada (pelo ID lido com pr_getInputLut) a itens de mídia do projeto; lutId null tira a LUT.",
    { items: { type: "array", items: itemRef }, lutId: { type: ["string", "null"] } }, EDIT, ["items", "lutId"]),
  t("pr_copyEffect", "Copiar efeito (colar atributos)", "Copia um efeito inteiro, todos os parâmetros, de um clipe para outros, como o Colar atributos do Premiere. Feito para a cor: o Lumetri leva a LUT de entrada, o look e os ajustes, que não atravessam o XML. from = clipe de origem {sequence, track, clip|time} (pode ser de outra sequência); clips = destinos na sequence. O destino recebe uma cópia do efeito da origem (a ocorrência dele no destino, se houver, é trocada); a origem fica intacta. effect padrão 'ADBE Lumetri'. metodo 'componente' (padrão) clona o efeito inteiro, com a LUT e o look; 'parametros' copia só os parâmetros numéricos (a API não lê LUT, look nem curvas). Relê e devolve verificado.",
    { from: { type: "object", description: "Clipe de origem: {sequence, track, clip} ou {sequence, track, time}.", properties: { sequence, track: { type: "string" }, clip: { type: ["integer", "string"] }, time }, required: ["track"] }, sequence, clips, effect: { type: "string" }, occurrence: { type: "integer" }, metodo: { type: "string", enum: ["componente", "parametros"] } }, EDIT, ["from", "clips"]),
  t("pr_inspectApi", "Inspecionar a API", "Lista as classes, métodos e constantes da API premierepro do Premiere aberto (path vazio = tudo; path 'Sequence' ou 'Constants.MediaType' = só aquele). Só leitura: serve para descobrir o que dá para automatizar.",
    { path: { type: "string" } }, RO),
  t("pr_reloadPanel", "Recarregar o painel", "Recarrega o painel Stocker Premiere com o código do disco. A ponte reconecta em uns 2 s.", {}, ADD),
  t("pr_trimClip", "Aparar clipe", "Apara um clipe da timeline como o trim do Premiere: start/end (segundos da timeline) movem a borda e o ponto da fonte junto; sourceIn/sourceOut aparam pela fonte (a borda na timeline acompanha). Só o clipe pedido: o áudio vinculado não acompanha, apare cada trilha. Relê e devolve antes/depois.",
    { sequence, clip: clipRef, start: time, end: time, sourceIn: time, sourceOut: time, raw: { type: "boolean", description: "Diagnóstico: aplica os primitivos crus, sem compensar a fonte." } }, EDIT, ["clip"]),
  t("pr_razor", "Cortar (razor)", "Corta os clipes que passam por `time` nas trilhas pedidas (padrão: todas), mantendo efeitos e volume nas duas metades.",
    { sequence, time, tracks: { type: "string", description: "all, video, audio ou lista \"V1,A1\"." } }, EDIT, ["time"]),
  t("pr_removeClips", "Remover clipes", "Tira clipes da timeline (a mídia continua no projeto). ripple:true fecha o vão só na trilha de cada clipe (os clipes seguintes dela andam para a esquerda). Para tirar um trecho mantendo todas as trilhas em sincronia, use pr_removeRange.",
    { sequence, clips, ripple: { type: "boolean" } }, EDIT, ["clips"]),
  t("pr_shiftClips", "Deslocar clipes", "Move clipes no tempo, na mesma trilha: offset em segundos (+ direita, − esquerda). Não sobrescreve: confira se o destino está livre.",
    { sequence, clips, offset: { type: "number" } }, EDIT, ["clips", "offset"]),
  t("pr_removeRange", "Extrair/Levantar trecho", "Tira o trecho [from, to) da sequência nas trilhas pedidas (padrão: todas), cortando os clipes nas bordas. ripple:true (padrão) = Extrair, fecha o vão e puxa os marcadores; ripple:false = Levantar, deixa lacuna. Substitui In/Out + Extrair pela tela.",
    { sequence, from: time, to: time, ripple: { type: "boolean" }, tracks: { type: "string" }, moveMarkers: { type: "boolean" } }, EDIT, ["from", "to"]),
  t("pr_openSequence", "Abrir sequência", "Abre a sequência na timeline e a deixa ativa.", { sequence }, ADD, ["sequence"]),
  t("pr_closeSequence", "Fechar aba da sequência", "Fecha a aba da sequência na timeline (não apaga nada).", { sequence }, ADD, ["sequence"]),
  t("pr_setPlayhead", "Mover agulha", "Põe a agulha (indicador de tempo) num tempo.", { sequence, time }, ADD, ["time"]),
  t("pr_setSequenceInOut", "In/Out da sequência", "Marca a entrada e/ou saída da sequência (usadas no export de trecho).", { sequence, in: time, out: time }, ADD),
  t("pr_setColorLabel", "Cor de rótulo", "Pinta itens do projeto (items) ou a mídia de clipes da timeline (clips) com uma cor de rótulo: violeta, iris, caribe, lavanda, ceruleo, floresta, rosa, manga, roxo, azul, petroleo, magenta, bege, verde, marrom, amarelo. A cor é do item: vale para todos os clipes daquela mídia.",
    { sequence, items: { type: "array", items: itemRef }, clips, color: { type: ["string", "integer"] } }, EDIT, ["color"]),
  t("pr_rename", "Renomear", "Renomeia uma coisa por chamada: renameSequence (nome atual da sequência), item (do projeto), bin (caminho), clip (da timeline, com sequence) ou track (\"V2\", com sequence).",
    { name: { type: "string" }, renameSequence: { type: "string" }, item: itemRef, bin: { type: "string" }, clip: clipRef, track: { type: "string" }, sequence }, EDIT, ["name"]),
  t("pr_moveToBin", "Mover para bin", "Move itens e/ou sequências do projeto para um bin (caminho \"A/B\", criado se faltar).",
    { items: { type: "array", items: itemRef }, sequences: { type: "array", items: { type: "string" } }, bin: { type: "string" } }, EDIT, ["bin"]),
  t("pr_relinkMedia", "Revincular mídia", "Troca o arquivo de itens do projeto sem mexer na timeline. fromDir+toDir troca a pasta de todos os itens que estão nela (mantém o resto do caminho); items:[{item, path}] troca um a um. dryRun:true só mostra o que faria.",
    { fromDir: { type: "string" }, toDir: { type: "string" }, items: { type: "array", items: { type: "object", properties: { item: itemRef, path: { type: "string" } } } }, dryRun: { type: "boolean" }, ignorarCompatibilidade: { type: "boolean" } }, EDIT),
  t("pr_listTransitions", "Listar transições", "Lista os matchNames das transições de vídeo instaladas.", { query: { type: "string" } }, RO),
  t("pr_addTransition", "Aplicar transição", "Põe uma transição de vídeo no início, no fim ou nas duas pontas de clipes. transition = matchName (padrão 'ADBE Cross Dissolve New'; veja pr_listTransitions); duration em segundos (padrão 0.5).",
    { sequence, clips, transition: { type: "string" }, duration: { type: "number" }, position: { type: "string", enum: ["start", "end", "both"] }, alignment: { type: "number" } }, EDIT, ["clips"]),
  t("pr_setTrackMute", "Mute de trilha", "Silencia/ativa trilhas de áudio ou liga/desliga o olho de trilhas de vídeo: tracks \"A3,V2\", muted true/false.",
    { sequence, tracks: { type: "string" }, muted: { type: "boolean" } }, EDIT, ["tracks", "muted"]),
  t("pr_exportTimeline", "Exportar XML/OTIO", "Exporta a sequência como XML do Final Cut Pro (.xml) ou OpenTimelineIO (.otio) num caminho absoluto. Bom para ler a montagem inteira ou levar para outro programa.",
    { sequence, outputPath: { type: "string" }, format: { type: "string", enum: ["fcpxml", "otio"] } }, ADD, ["outputPath"]),
  t("pr_getCaptions", "Ler legendas", "Lê as trilhas de legenda (C1, C2…) da sequência: quantos itens, tempos e o nome que a API dá a cada um. A API do Premiere 27.1 não deixa editar texto de legenda nem pôr SRT na timeline.",
    { sequence, maxItems: { type: "integer" } }, RO),
  t("pr_exportFrame", "Ver um quadro", "Renderiza o quadro num tempo (padrão: playhead) e devolve a imagem (PNG, 1280 px de largura por padrão). Use depois de mudanças visuais.",
    { sequence, time, width: { type: "integer" }, height: { type: "integer" } }, RO),
  t("pr_exportSequence", "Exportar vídeo", "Exporta a sequência com um preset (.epr): modo 'agora' (renderiza no Premiere) ou 'fila_ame' (manda para o Media Encoder). Só com aprovação explícita do usuário: exige confirmado:true.",
    { sequence, outputPath: { type: "string" }, preset: { type: "string" }, modo: { type: "string", enum: ["agora", "fila_ame"] }, inteira: { type: "boolean" }, confirmado: { type: "boolean" } }, EDIT, ["outputPath", "preset", "confirmado"]),
];

const TOOL_NAMES = new Set(TOOLS.map((x) => x.name));
const EDIT_PLAN_ALLOWED = new Set(["pr_getProjectState", "pr_getSequenceState", "pr_importFiles", "pr_createSequence", "pr_duplicateSequence",
  "pr_placeClip", "pr_moveClip", "pr_setClipEnabled", "pr_addMarkers", "pr_setClipProperties", "pr_applyEffect", "pr_applyAudioEffect", "pr_setEffectProperties", "pr_setInputLut", "pr_copyEffect", "pr_trimClip", "pr_razor", "pr_removeClips", "pr_shiftClips", "pr_removeRange", "pr_openSequence", "pr_setPlayhead", "pr_setSequenceInOut", "pr_setColorLabel", "pr_rename", "pr_moveToBin", "pr_addTransition", "pr_setTrackMute"]);
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
8. Cada passo lógico vira um ou mais passos de desfazer no Premiere (colocar um trecho usa 3). Diga o que mudou.
9. Antes de controlar a tela, procure a tool: cortar/aparar/extrair (pr_razor, pr_trimClip, pr_removeRange, pr_removeClips, pr_shiftClips), abrir sequência, agulha e In/Out, revincular (pr_relinkMedia), cor/nome/bin, transição, mute e XML já são pela ponte. Pela tela só sobra: texto e estilo de legenda, efeitos no mixer de trilha, velocidade, desfazer.
10. pr_inspectApi mostra a API viva do Premiere quando faltar uma tool.`;

module.exports = { VERSION, TOOLS, TOOL_NAMES, EDIT_PLAN_ALLOWED, timeoutFor, INSTRUCTIONS };
