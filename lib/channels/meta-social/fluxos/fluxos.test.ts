import { describe, expect, it } from "vitest";

import { gatilhoQueCasa, normalizar, origemDoEvento, primeiroFluxoQueCasa, type EventoDoFluxo } from "./casar";
import { condicaoVale, executarPassos, preencher, type ContextoDoFluxo, type PortasDoFluxo } from "./executar";
import { lerFluxo, type Fluxo } from "./schema";

const evento = (extra: Partial<EventoDoFluxo> = {}): EventoDoFluxo => ({
  tipo: "comentario",
  texto: "quero o molde!",
  midiaId: "m1",
  produto: "REELS",
  aoVivo: false,
  ...extra,
});

const FLUXO: Fluxo = {
  versao: 1,
  nome: "Moldes",
  gatilhos: [
    { tipo: "comentario", palavras: ["molde", "moldes"], modo: "contem" },
    { tipo: "dm", palavras: ["molde"], modo: "exata" },
  ],
  passos: [{ tipo: "enviar_dm", texto: "oi" }],
};

describe("lerFluxo (importar JSON)", () => {
  it("aceita um fluxo válido e preenche os padrões", () => {
    const r = lerFluxo({ nome: "A", gatilhos: [{ tipo: "dm" }], passos: [{ tipo: "etiquetar", etiqueta: "x" }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fluxo.versao).toBe(1);
      expect(r.fluxo.gatilhos[0]).toMatchObject({ modo: "contem", palavras: [] });
    }
  });

  it("recusa campo desconhecido, botão sem https e fluxo sem passos, dizendo onde", () => {
    const a = lerFluxo({ nome: "A", gatilhos: [{ tipo: "dm" }], passos: [], extra: 1 });
    expect(a.ok).toBe(false);
    const b = lerFluxo({ nome: "A", gatilhos: [{ tipo: "dm" }], passos: [{ tipo: "enviar_dm", texto: "x", botao: { titulo: "ir", url: "http://inseguro.com" } }] });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.problemas.join(" ")).toMatch(/passos/);
  });

  it("os passos se aninham: se → entao/senao com outros passos", () => {
    const r = lerFluxo({
      nome: "A",
      gatilhos: [{ tipo: "comentario", palavras: ["x"] }],
      passos: [{ tipo: "se", condicao: { campo: "origem", op: "igual", valor: "comentario_reel" }, entao: [{ tipo: "etiquetar", etiqueta: "reel" }] }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("casamento dos gatilhos", () => {
  it("normaliza acento e caixa", () => {
    expect(normalizar("  MOLDÉ  Lindo ")).toBe("molde lindo");
  });

  it("palavra INTEIRA: casa 'molde' em 'quero o molde!' e não em 'moldeira'", () => {
    expect(gatilhoQueCasa(FLUXO, evento())).toEqual({ palavra: "molde" });
    expect(gatilhoQueCasa(FLUXO, evento({ texto: "moldeira" }))).toBeNull();
    expect(gatilhoQueCasa(FLUXO, evento({ texto: "MOLDES!!" }))).toEqual({ palavra: "moldes" });
  });

  it("o gatilho de DM é de DM: comentário não dispara o gatilho de DM e vice-versa", () => {
    const soDm: Fluxo = { ...FLUXO, gatilhos: [{ tipo: "dm", palavras: ["molde"], modo: "contem" }] };
    expect(gatilhoQueCasa(soDm, evento())).toBeNull();
    expect(gatilhoQueCasa(soDm, evento({ tipo: "dm" }))).toEqual({ palavra: "molde" });
  });

  it("modo exata exige o texto inteiro; modo qualquer dispara em toda mensagem", () => {
    expect(gatilhoQueCasa(FLUXO, evento({ tipo: "dm", texto: "molde" }))).toEqual({ palavra: "molde" });
    expect(gatilhoQueCasa(FLUXO, evento({ tipo: "dm", texto: "quero molde" }))).toBeNull();
    const todos: Fluxo = { ...FLUXO, gatilhos: [{ tipo: "resposta_story", palavras: [], modo: "qualquer" }] };
    expect(gatilhoQueCasa(todos, evento({ tipo: "resposta_story", texto: "kkk" }))).toEqual({ palavra: null });
  });

  it("filtra por mídia: só no Reel escolhido", () => {
    const f: Fluxo = { ...FLUXO, gatilhos: [{ tipo: "comentario", palavras: ["molde"], modo: "contem", midia: "m9" }] };
    expect(gatilhoQueCasa(f, evento({ midiaId: "m1" }))).toBeNull();
    expect(gatilhoQueCasa(f, evento({ midiaId: "m9" }))).toEqual({ palavra: "molde" });
  });

  it("comentário em Live casa o gatilho de comentário e o de live", () => {
    expect(gatilhoQueCasa(FLUXO, evento({ aoVivo: true }))).toEqual({ palavra: "molde" });
    const live: Fluxo = { ...FLUXO, gatilhos: [{ tipo: "live", palavras: ["molde"], modo: "contem" }] };
    expect(gatilhoQueCasa(live, evento({ aoVivo: true }))).toEqual({ palavra: "molde" });
    expect(gatilhoQueCasa(live, evento({ aoVivo: false }))).toBeNull();
  });

  it("um evento dispara UM fluxo: o primeiro da lista que casa", () => {
    const outro: Fluxo = { ...FLUXO, nome: "Outro" };
    const r = primeiroFluxoQueCasa([{ fluxo: FLUXO, id: "a" }, { fluxo: outro, id: "b" }], evento());
    expect(r!.item.id).toBe("a");
  });
});

describe("origem do evento", () => {
  it("distingue Reel, post, anúncio, Live, Story e DM", () => {
    expect(origemDoEvento(evento({ produto: "REELS" }))).toBe("comentario_reel");
    expect(origemDoEvento(evento({ produto: "FEED" }))).toBe("comentario_post");
    expect(origemDoEvento(evento({ produto: "AD" }))).toBe("comentario_anuncio");
    expect(origemDoEvento(evento({ aoVivo: true }))).toBe("comentario_live");
    expect(origemDoEvento(evento({ tipo: "resposta_story" }))).toBe("resposta_story");
    expect(origemDoEvento(evento({ tipo: "dm" }))).toBe("dm");
  });
});

const ctx = (extra: Partial<ContextoDoFluxo> = {}): ContextoDoFluxo => ({
  origem: "comentario_reel",
  palavra: "molde",
  primeiraVez: true,
  etiquetas: new Set(),
  nome: "Maria Silva",
  usuario: "maria.silva",
  hora: 14,
  ...extra,
});

describe("preencher", () => {
  it("troca as variáveis; o que não existe some, sem 'undefined'", () => {
    expect(preencher("Oi {{nome}} ({{usuario}}) — {{palavra}} / {{origem}} {{naoexiste}}!", ctx())).toBe("Oi Maria (@maria.silva) — molde / comentario_reel !");
    expect(preencher("Oi {{nome}}, tudo bem?", ctx({ nome: null }))).toBe("Oi , tudo bem?");
  });
});

describe("condicaoVale", () => {
  it("origem, palavra e primeira vez", () => {
    expect(condicaoVale({ campo: "origem", op: "igual", valor: "comentario_reel" }, ctx())).toBe(true);
    expect(condicaoVale({ campo: "origem", op: "diferente", valor: "dm" }, ctx())).toBe(true);
    expect(condicaoVale({ campo: "palavra", op: "contem", valor: "mol" }, ctx())).toBe(true);
    expect(condicaoVale({ campo: "primeira_vez", op: "igual", valor: true }, ctx())).toBe(true);
    expect(condicaoVale({ campo: "primeira_vez", op: "igual", valor: true }, ctx({ primeiraVez: false }))).toBe(false);
  });

  it("etiqueta e janela de horas (inclusive a que vira a noite)", () => {
    expect(condicaoVale({ campo: "tem_etiqueta", op: "igual", valor: "vip" }, ctx({ etiquetas: new Set(["vip"]) }))).toBe(true);
    expect(condicaoVale({ campo: "tem_etiqueta", op: "diferente", valor: "vip" }, ctx())).toBe(true);
    expect(condicaoVale({ campo: "hora", op: "entre", valor: ["9", "18"] }, ctx({ hora: 14 }))).toBe(true);
    expect(condicaoVale({ campo: "hora", op: "entre", valor: ["22", "6"] }, ctx({ hora: 23 }))).toBe(true);
    expect(condicaoVale({ campo: "hora", op: "entre", valor: ["22", "6"] }, ctx({ hora: 14 }))).toBe(false);
  });
});

function portas() {
  const chamadas: string[] = [];
  const p: PortasDoFluxo = {
    responderComentario: async (t) => void chamadas.push(`publico:${t}`),
    enviarDm: async (i) => void chamadas.push(`dm:${i.texto}${i.botao ? `[${i.botao.titulo}]` : ""}`),
    etiquetar: async (e) => void chamadas.push(`etiqueta:${e}`),
    esperar: async (s) => void chamadas.push(`espera:${s}`),
    sortear: (o) => o[0]!,
  };
  return { p, chamadas };
}

describe("executarPassos", () => {
  it("executa em ordem, preenche o texto e desvia o `se` pela origem", async () => {
    const { p, chamadas } = portas();
    const r = lerFluxo({
      nome: "F",
      gatilhos: [{ tipo: "comentario", palavras: ["molde"] }],
      passos: [
        { tipo: "se", condicao: { campo: "origem", op: "igual", valor: "comentario_reel" }, entao: [{ tipo: "etiquetar", etiqueta: "veio-do-reel" }], senao: [{ tipo: "etiquetar", etiqueta: "outro" }] },
        { tipo: "responder_comentario", textos: ["Te mandei no privado, {{nome}}!"] },
        { tipo: "enviar_dm", texto: "Olá, {{nome}}", botao: { titulo: "ACESSAR", url: "https://exemplo.com/x" } },
      ],
    });
    if (!r.ok) throw new Error("fluxo de teste inválido");
    const rel = await executarPassos(r.fluxo.passos, ctx(), p);
    expect(chamadas).toEqual(["etiqueta:veio-do-reel", "publico:Te mandei no privado, Maria!", "dm:Olá, Maria[ACESSAR]"]);
    expect(rel.every((x) => x.estado === "feito")).toBe(true);
  });

  it("com outra origem o `se` toma o caminho do senão", async () => {
    const { p, chamadas } = portas();
    await executarPassos(
      [{ tipo: "se", condicao: { campo: "origem", op: "igual", valor: "comentario_reel" }, entao: [{ tipo: "etiquetar", etiqueta: "reel" }], senao: [{ tipo: "etiquetar", etiqueta: "outro" }] }],
      ctx({ origem: "dm" }),
      p,
    );
    expect(chamadas).toEqual(["etiqueta:outro"]);
  });

  it("a resposta pública que falha NÃO impede a DM, e o relatório diz o que falhou", async () => {
    const { p, chamadas } = portas();
    p.responderComentario = async () => {
      throw new Error("A Meta recusou.");
    };
    const rel = await executarPassos(
      [
        { tipo: "responder_comentario", textos: ["x"] },
        { tipo: "enviar_dm", texto: "oi" },
      ],
      ctx(),
      p,
    );
    expect(chamadas).toEqual(["dm:oi"]);
    expect(rel).toEqual([
      { tipo: "responder_comentario", estado: "falhou", detalhe: "A Meta recusou." },
      { tipo: "enviar_dm", estado: "feito" },
    ]);
  });

  it("a etiqueta posta por um passo vale para os `se` seguintes", async () => {
    const { p, chamadas } = portas();
    await executarPassos(
      [
        { tipo: "etiquetar", etiqueta: "vip" },
        { tipo: "se", condicao: { campo: "tem_etiqueta", op: "igual", valor: "vip" }, entao: [{ tipo: "enviar_dm", texto: "vip!" }], senao: [] },
      ],
      ctx(),
      p,
    );
    expect(chamadas).toEqual(["etiqueta:vip", "dm:vip!"]);
  });
});
