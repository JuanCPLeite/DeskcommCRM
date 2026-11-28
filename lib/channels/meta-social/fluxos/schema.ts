/**
 * O FORMATO do fluxo social (Instagram), em JSON. Um fluxo é só dados: dá para importar, exportar,
 * duplicar e versionar sem tocar em código.
 *
 *   {
 *     "versao": 1,
 *     "nome": "Moldes",
 *     "gatilhos": [
 *       { "tipo": "comentario", "palavras": ["molde", "moldes"], "modo": "contem", "midia": null },
 *       { "tipo": "dm",         "palavras": ["molde"],            "modo": "contem" },
 *       { "tipo": "resposta_story", "palavras": [], "modo": "qualquer" }
 *     ],
 *     "passos": [
 *       { "tipo": "se", "condicao": { "campo": "origem", "op": "igual", "valor": "comentario_reel" },
 *         "entao": [ { "tipo": "etiquetar", "etiqueta": "veio-do-reel" } ], "senao": [] },
 *       { "tipo": "responder_comentario", "textos": ["Te mandei no privado! 💜", "Olha seu direct 💌"] },
 *       { "tipo": "enviar_dm", "texto": "Olá, {{nome}}! Aqui está:", "botao": { "titulo": "ACESSAR", "url": "https://..." } }
 *     ]
 *   }
 *
 * Os mesmos gatilhos servem ao mesmo fluxo: a ORIGEM (`origem`) de cada evento chega como variável, e o passo
 * `se` desvia o caminho por ela — sem campo personalizado montado à mão.
 */
import { z } from "zod";

export const VERSAO_DO_FORMATO = 1;

/** De onde veio o evento. É a variável `origem` que os passos `se` e os textos enxergam. */
export const ORIGENS = [
  "comentario_post",
  "comentario_reel",
  "comentario_live",
  "comentario_anuncio",
  "resposta_story",
  "dm",
] as const;
export type Origem = (typeof ORIGENS)[number];

/** Os tipos de gatilho, cada um casando um grupo de origens. */
export const TIPOS_DE_GATILHO = ["comentario", "dm", "resposta_story", "live"] as const;
export type TipoDeGatilho = (typeof TIPOS_DE_GATILHO)[number];

const palavra = z.string().trim().min(1).max(60);

export const gatilhoSchema = z
  .object({
    tipo: z.enum(TIPOS_DE_GATILHO),
    palavras: z.array(palavra).max(30).default([]),
    /** `contem`: a palavra aparece no texto (inteira). `exata`: o texto todo é a palavra. `qualquer`: toda mensagem. */
    modo: z.enum(["contem", "exata", "qualquer"]).default("contem"),
    /** Só neste post/Reel/Story/Live (o id da mídia). Vazio = em todos. */
    midia: z.string().trim().max(60).nullish(),
  })
  .strict();

export const condicaoSchema = z
  .object({
    campo: z.enum(["origem", "palavra", "primeira_vez", "tem_etiqueta", "hora"]),
    op: z.enum(["igual", "diferente", "contem", "entre"]),
    valor: z.union([z.string().max(80), z.boolean(), z.array(z.string().max(40)).max(2)]),
  })
  .strict();

export type Passo =
  | { tipo: "se"; condicao: z.infer<typeof condicaoSchema>; entao: Passo[]; senao: Passo[] }
  | { tipo: "responder_comentario"; textos: string[] }
  | { tipo: "enviar_dm"; texto: string; botao?: { titulo: string; url: string } | null }
  | { tipo: "etiquetar"; etiqueta: string }
  | { tipo: "esperar"; segundos: number };

const textoLongo = z.string().trim().min(1).max(1000);

export const passoSchema: z.ZodType<Passo> = z.lazy(() =>
  z.discriminatedUnion("tipo", [
    z
      .object({ tipo: z.literal("se"), condicao: condicaoSchema, entao: z.array(passoSchema).max(20), senao: z.array(passoSchema).max(20).default([]) })
      .strict(),
    z.object({ tipo: z.literal("responder_comentario"), textos: z.array(textoLongo.max(300)).min(1).max(10) }).strict(),
    z
      .object({
        tipo: z.literal("enviar_dm"),
        texto: textoLongo,
        // A DM com botão leva só endereço https: o botão abre fora do CRM.
        botao: z
          .object({ titulo: z.string().trim().min(1).max(20), url: z.string().url().startsWith("https://").max(500) })
          .strict()
          .nullish(),
      })
      .strict(),
    z.object({ tipo: z.literal("etiquetar"), etiqueta: z.string().trim().min(1).max(40) }).strict(),
    // O teto de 60 s: a execução acontece dentro de uma entrega de webhook; esperas longas são de agendamento.
    z.object({ tipo: z.literal("esperar"), segundos: z.number().int().min(1).max(60) }).strict(),
  ]) as z.ZodType<Passo>,
);

export const fluxoSchema = z
  .object({
    versao: z.literal(VERSAO_DO_FORMATO).default(VERSAO_DO_FORMATO),
    nome: z.string().trim().min(1).max(80),
    gatilhos: z.array(gatilhoSchema).min(1).max(10),
    passos: z.array(passoSchema).min(1).max(40),
  })
  .strict();

export type Fluxo = z.infer<typeof fluxoSchema>;

/** Valida um JSON importado. Devolve o fluxo, ou os problemas em frases para a tela mostrar. */
export function lerFluxo(bruto: unknown): { ok: true; fluxo: Fluxo } | { ok: false; problemas: string[] } {
  const r = fluxoSchema.safeParse(bruto);
  if (r.success) return { ok: true, fluxo: r.data };
  return { ok: false, problemas: r.error.issues.map((i) => `${i.path.join(".") || "fluxo"}: ${i.message}`).slice(0, 10) };
}
