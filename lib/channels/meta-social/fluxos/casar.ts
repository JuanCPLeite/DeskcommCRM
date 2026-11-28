/**
 * Que fluxo dispara para um evento: casa o GATILHO (tipo + palavras + mídia) e devolve a ORIGEM do evento.
 * Puro: não toca em banco nem em rede.
 */
import type { Fluxo, Origem, TipoDeGatilho } from "./schema";

export interface EventoDoFluxo {
  /** `comentario`: comentário em post, Reel, anúncio ou Live. `dm`: mensagem direta. `resposta_story`: DM que responde a um Story. */
  tipo: "comentario" | "dm" | "resposta_story";
  texto: string;
  /** O post, Reel, Story ou Live de origem. */
  midiaId: string | null;
  /** `REELS`, `FEED`, `AD`… como a Meta devolveu (só em comentário). */
  produto: string | null;
  aoVivo: boolean;
}

/** Sem acento, minúsculo, espaços simples: a pessoa escreve "MOLDÉ" e o fluxo guarda "molde". */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A palavra aparece INTEIRA no texto ("molde" casa "quero molde!" e não casa "moldeira"). */
function contemPalavra(texto: string, palavra: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapar(palavra)}([^\\p{L}\\p{N}]|$)`, "u").test(texto);
}

export function origemDoEvento(e: EventoDoFluxo): Origem {
  if (e.tipo === "dm") return "dm";
  if (e.tipo === "resposta_story") return "resposta_story";
  if (e.aoVivo) return "comentario_live";
  if (e.produto === "REELS") return "comentario_reel";
  if (e.produto === "AD") return "comentario_anuncio";
  return "comentario_post";
}

/** O gatilho do tipo certo que casa com o evento, e a palavra que casou. */
export function gatilhoQueCasa(fluxo: Pick<Fluxo, "gatilhos">, e: EventoDoFluxo): { palavra: string | null } | null {
  const tipoDoEvento: TipoDeGatilho = e.tipo === "comentario" && e.aoVivo ? "live" : e.tipo;
  const texto = normalizar(e.texto);
  for (const g of fluxo.gatilhos) {
    // O gatilho de comentário também serve ao comentário em Live, a menos que haja um `live` próprio.
    const serve = g.tipo === tipoDoEvento || (g.tipo === "comentario" && tipoDoEvento === "live");
    if (!serve) continue;
    if (g.midia && g.midia !== e.midiaId) continue;
    if (g.modo === "qualquer") return { palavra: null };
    const palavras = g.palavras.map(normalizar).filter(Boolean);
    for (const p of palavras) {
      if (g.modo === "exata" ? texto === p : contemPalavra(texto, p)) return { palavra: p };
    }
  }
  return null;
}

/** Entre os fluxos ativos, o primeiro que casa (a ordem é a da lista). Um evento dispara UM fluxo. */
export function primeiroFluxoQueCasa<T extends { fluxo: Pick<Fluxo, "gatilhos"> }>(
  fluxos: T[],
  e: EventoDoFluxo,
): { item: T; palavra: string | null } | null {
  for (const item of fluxos) {
    const c = gatilhoQueCasa(item.fluxo, e);
    if (c) return { item, palavra: c.palavra };
  }
  return null;
}
