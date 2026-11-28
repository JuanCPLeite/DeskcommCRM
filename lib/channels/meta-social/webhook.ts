/**
 * Lê a entrega de webhook da Meta para o canal DIRETO de Instagram e a reduz a
 * uma lista de eventos neutros. NUNCA lança: o corpo vem de fora, e a Meta
 * reentrega em backoff o que recebe como erro — então o que não se entende vira
 * lista vazia (ou `outro`), nunca exceção.
 *
 * Duas famílias de itens numa mesma entrega:
 *  - `entry[].messaging[]`: DM, eco da DM que o próprio CRM enviou, e clique em botão;
 *  - `entry[].changes[]`: comentário em post/Reel (`comments`) e em Live (`live_comments`).
 *
 * `entry[].id` é a CONTA (o id que a Graph API endereça): é por ela que o
 * servidor acha a organização — nunca por nada que o corpo diga sobre tenant.
 */

export type TipoDeEventoMetaSocial = "mensagem" | "eco" | "postback" | "comentario" | "outro";

export interface MetaSocialEvento {
  tipo: TipoDeEventoMetaSocial;
  /** A conta Instagram do CRM (`entry[].id`). */
  contaId: string;
  /** A outra ponta: quem escreveu, ou — no eco — para quem o CRM escreveu. */
  participanteId: string;
  /** Id da mensagem, do postback ou do comentário (a chave de idempotência). */
  mid: string;
  texto: string | null;
  anexos: { tipo: string; url: string }[];
  enviadoEm: Date;
  /** Resposta a um Story: o id do Story. */
  replyToStory?: string | null;
  /** O `payload` do botão, em `postback`. */
  payload?: string | null;
  /** Comentário feito numa Live. */
  aoVivo?: boolean;
  /** O post/Reel/Live comentado. */
  midiaId?: string | null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function id(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** O instante do item: ms do próprio item, senão o da entrada (que às vezes vem em s), senão agora. */
function instante(...candidatos: unknown[]): Date {
  for (const c of candidatos) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) {
      // A Meta manda ms nas mensagens e s em alguns `changes`: abaixo de 1e11 é segundo.
      return new Date(c < 1e11 ? c * 1000 : c);
    }
  }
  return new Date();
}

function anexos(message: Obj): { tipo: string; url: string }[] {
  const lista = Array.isArray(message.attachments) ? message.attachments : [];
  const saida: { tipo: string; url: string }[] = [];
  for (const item of lista) {
    const a = obj(item);
    const url = texto(obj(a?.payload)?.url);
    const tipo = texto(a?.type);
    if (a && tipo && url) saida.push({ tipo, url });
  }
  return saida;
}

function doItemDeMensagem(contaId: string, entradaTime: unknown, item: unknown): MetaSocialEvento | null {
  const m = obj(item);
  if (!m) return null;
  const remetente = id(obj(m.sender)?.id);
  const destinatario = id(obj(m.recipient)?.id);
  const quando = instante(m.timestamp, entradaTime);

  const message = obj(m.message);
  if (message) {
    const mid = id(message.mid);
    if (!mid) return null;
    const eco = message.is_echo === true;
    const participante = eco ? destinatario : remetente;
    if (!participante) return null;
    return {
      tipo: eco ? "eco" : "mensagem",
      contaId,
      participanteId: participante,
      mid,
      texto: texto(message.text),
      anexos: anexos(message),
      enviadoEm: quando,
      replyToStory: id(obj(obj(message.reply_to)?.story)?.id),
    };
  }

  const postback = obj(m.postback);
  if (postback && remetente) {
    const mid = id(postback.mid);
    if (!mid) return null;
    return {
      tipo: "postback",
      contaId,
      participanteId: remetente,
      mid,
      texto: texto(postback.title),
      anexos: [],
      enviadoEm: quando,
      payload: texto(postback.payload),
    };
  }
  return null;
}

function doItemDeMudanca(contaId: string, entradaTime: unknown, item: unknown): MetaSocialEvento | null {
  const c = obj(item);
  if (!c) return null;
  const campo = texto(c.field);
  const valor = obj(c.value);
  if (campo === "comments" || campo === "live_comments") {
    const comentario = id(valor?.id);
    const autor = id(obj(valor?.from)?.id);
    if (!comentario || !autor) return null;
    return {
      tipo: "comentario",
      contaId,
      participanteId: autor,
      mid: comentario,
      texto: texto(valor?.text),
      anexos: [],
      enviadoEm: instante(entradaTime),
      aoVivo: campo === "live_comments",
      midiaId: id(obj(valor?.media)?.id),
    };
  }
  // A DM entregue como MUDANÇA (`field: "messages"`): o `value` tem o mesmo desenho de um item de
  // `messaging[]` (sender, recipient, timestamp, message). A Meta usa as duas formas conforme o app.
  if (campo === "messages" && valor) {
    const ev = doItemDeMensagem(contaId, entradaTime, valor);
    if (ev) return ev;
  }
  // Campo que a Meta mandou e o canal não trata: registra que veio, sem efeito.
  return campo ? { tipo: "outro", contaId, participanteId: "", mid: "", texto: null, anexos: [], enviadoEm: instante(entradaTime) } : null;
}

export function parseMetaSocialWebhook(raw: unknown): MetaSocialEvento[] {
  const corpo = obj(raw);
  if (!corpo || corpo.object !== "instagram" || !Array.isArray(corpo.entry)) return [];

  const eventos: MetaSocialEvento[] = [];
  for (const e of corpo.entry) {
    const entrada = obj(e);
    const contaId = id(entrada?.id);
    if (!entrada || !contaId) continue;
    // `standby` leva itens do MESMO desenho que `messaging`: a Meta os entrega ali quando outro app é o
    // receptor principal da conversa (protocolo de passagem). Para o CRM é a mesma DM.
    for (const lista of [entrada.messaging, entrada.standby]) {
      for (const item of Array.isArray(lista) ? lista : []) {
        const ev = doItemDeMensagem(contaId, entrada.time, item);
        if (ev) eventos.push(ev);
      }
    }
    for (const item of Array.isArray(entrada.changes) ? entrada.changes : []) {
      const ev = doItemDeMudanca(contaId, entrada.time, item);
      if (ev) eventos.push(ev);
    }
  }
  return eventos;
}

/**
 * O DESENHO de uma entrega, sem nenhum conteúdo: quais contas, quais famílias (`messaging` ou
 * `changes`) e quais campos. É o que o log mostra, para a próxima entrega que o leitor não entender
 * (ou que vier de uma conta que ninguém conectou) ter um rastro.
 */
export function desenhoDaEntrega(raw: unknown): {
  objeto: string | null;
  entradas: { conta: string | null; chaves: string[]; messaging: number; campos: string[] }[];
} {
  const corpo = obj(raw);
  const entradas = Array.isArray(corpo?.entry) ? (corpo.entry as unknown[]) : [];
  return {
    objeto: typeof corpo?.object === "string" ? corpo.object : null,
    entradas: entradas.map((e) => {
      const entrada = obj(e);
      return {
        conta: id(entrada?.id),
        // Os NOMES das chaves da entrada (nunca os valores): mostram em que lugar a Meta pôs o conteúdo.
        chaves: Object.keys(entrada ?? {}).slice(0, 12),
        messaging: Array.isArray(entrada?.messaging) ? entrada.messaging.length : 0,
        campos: (Array.isArray(entrada?.changes) ? (entrada.changes as unknown[]) : []).map((c) => texto(obj(c)?.field) ?? "?").slice(0, 10),
      };
    }),
  };
}
