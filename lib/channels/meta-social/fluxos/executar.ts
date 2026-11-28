/**
 * O EXECUTOR do fluxo: percorre os passos, resolve os `se` pela ORIGEM e pelos fatos do contato, e chama as
 * PORTAS de efeito (responder, enviar DM, etiquetar). As portas são injetadas: o executor não sabe o que é
 * a Meta nem o banco — por isso o teste prova o desenho sem rede.
 *
 * A falha de um passo não derruba os seguintes em silêncio: ela é registrada no relatório e o fluxo segue,
 * porque a resposta pública que falhou não deve impedir a DM.
 */
import { normalizar } from "./casar";
import type { Origem, Passo } from "./schema";

export interface ContextoDoFluxo {
  origem: Origem;
  palavra: string | null;
  primeiraVez: boolean;
  etiquetas: ReadonlySet<string>;
  nome: string | null;
  usuario: string | null;
  /** Hora local do atendimento (0 a 23). */
  hora: number;
}

export interface PortasDoFluxo {
  responderComentario(texto: string): Promise<void>;
  enviarDm(input: { texto: string; botao: { titulo: string; url: string } | null }): Promise<void>;
  etiquetar(etiqueta: string): Promise<void>;
  esperar(segundos: number): Promise<void>;
  /** Escolhe uma entre as variações (injetado para o teste ser determinístico). */
  sortear(opcoes: string[]): string;
}

export interface RelatorioDoPasso {
  tipo: Passo["tipo"];
  estado: "feito" | "falhou" | "pulado";
  detalhe?: string;
}

/** `{{nome}}`, `{{usuario}}`, `{{palavra}}`, `{{origem}}`: o que não existe vira vazio, nunca o texto `undefined`. */
export function preencher(texto: string, ctx: ContextoDoFluxo): string {
  const valores: Record<string, string> = {
    nome: (ctx.nome ?? "").trim().split(" ")[0] ?? "",
    usuario: ctx.usuario ? `@${ctx.usuario.replace(/^@/, "")}` : "",
    palavra: ctx.palavra ?? "",
    origem: ctx.origem,
  };
  return texto
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, chave: string) => valores[chave] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function condicaoVale(c: { campo: string; op: string; valor: string | boolean | string[] }, ctx: ContextoDoFluxo): boolean {
  if (c.campo === "tem_etiqueta") {
    if (typeof c.valor !== "string") return false;
    const tem = ctx.etiquetas.has(c.valor);
    return c.op === "diferente" ? !tem : tem;
  }
  if (c.campo === "hora") {
    if (c.op !== "entre" || !Array.isArray(c.valor) || c.valor.length !== 2) return false;
    const a = Number(c.valor[0]);
    const b = Number(c.valor[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    // Janela que vira a noite (22 a 6) é legítima.
    return a <= b ? ctx.hora >= a && ctx.hora < b : ctx.hora >= a || ctx.hora < b;
  }
  const atual: string | boolean = c.campo === "origem" ? ctx.origem : c.campo === "palavra" ? ctx.palavra ?? "" : c.campo === "primeira_vez" ? ctx.primeiraVez : "";
  if (typeof atual === "boolean") {
    if (c.op === "igual") return atual === c.valor;
    if (c.op === "diferente") return atual !== c.valor;
    return false;
  }
  const a = normalizar(atual);
  const v = normalizar(String(c.valor));
  if (c.op === "igual") return a === v;
  if (c.op === "diferente") return a !== v;
  if (c.op === "contem") return a.includes(v);
  return false;
}

export async function executarPassos(passos: Passo[], ctx: ContextoDoFluxo, portas: PortasDoFluxo): Promise<RelatorioDoPasso[]> {
  const relatorio: RelatorioDoPasso[] = [];
  for (const passo of passos) {
    try {
      switch (passo.tipo) {
        case "se": {
          const vale = condicaoVale(passo.condicao, ctx);
          relatorio.push({ tipo: "se", estado: "feito", detalhe: vale ? "entao" : "senao" });
          relatorio.push(...(await executarPassos(vale ? passo.entao : passo.senao, ctx, portas)));
          break;
        }
        case "responder_comentario":
          await portas.responderComentario(preencher(portas.sortear(passo.textos), ctx));
          relatorio.push({ tipo: passo.tipo, estado: "feito" });
          break;
        case "enviar_dm":
          await portas.enviarDm({ texto: preencher(passo.texto, ctx), botao: passo.botao ?? null });
          relatorio.push({ tipo: passo.tipo, estado: "feito" });
          break;
        case "etiquetar":
          await portas.etiquetar(passo.etiqueta);
          ctx.etiquetas = new Set([...ctx.etiquetas, passo.etiqueta]);
          relatorio.push({ tipo: passo.tipo, estado: "feito" });
          break;
        case "esperar":
          await portas.esperar(passo.segundos);
          relatorio.push({ tipo: passo.tipo, estado: "feito" });
          break;
      }
    } catch (err) {
      relatorio.push({ tipo: passo.tipo, estado: "falhou", detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
  return relatorio;
}
