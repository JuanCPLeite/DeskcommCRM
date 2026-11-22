"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { respostaParaOperador } from "@/lib/erros/para-operador";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateMetaSignupResult = { ok: true } | { ok: false; error: string; details?: unknown };

/**
 * Os IDENTIFICADORES do Embedded Signup do app da instalação (Tech Provider) e o
 * padrão de liberação (migration 9452).
 *
 * ── Por que `is_platform_admin`, e não `admin` do tenant ─────────────────────
 *
 * Mesmo argumento de `updateMetaApp.ts`: o objeto é a INSTALAÇÃO. Um `config_id`
 * errado trocado por um admin de tenant derrubaria a conexão de números de TODAS
 * as empresas da VPS.
 *
 * ── Por que NÃO é segredo, e mesmo assim passa por aqui ──────────────────────
 *
 * `app_id` e `config_id` vão ao navegador por desenho — a Meta os exige no
 * `FB.init`/`FB.login`. Não há cifra. O que a ação valida é o FORMATO (numérico):
 * erro de cópia aqui vira uma janela da Meta que abre em branco, sem mensagem.
 *
 * ── Vazio significa "limpar", ausente significa "manter" ─────────────────────
 *
 * `undefined` não toca na coluna; string vazia a zera. Salvar a tela sem mexer num
 * campo não pode apagá-lo.
 */
const idOpcional = z
  .union([z.string().trim().regex(/^[0-9]{5,30}$/, "id_da_meta_invalido"), z.literal("")])
  .optional();

const entradaSchema = z.object({
  app_id: idOpcional,
  signup_config_id: idOpcional,
  signup_config_id_coexistencia: idOpcional,
  signup_liberado_por_padrao: z.boolean().optional(),
});

export type MetaSignupInput = z.infer<typeof entradaSchema>;

export async function updateMetaSignup(input: MetaSignupInput): Promise<UpdateMetaSignupResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user: authUser } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  const d = parsed.data;
  const valores: Record<string, unknown> = { updated_by: authUser.id };
  const campos: string[] = [];
  const mapa: Array<[keyof MetaSignupInput, string]> = [
    ["app_id", "app_id"],
    ["signup_config_id", "signup_config_id"],
    ["signup_config_id_coexistencia", "signup_config_id_coexistencia"],
  ];
  for (const [chave, coluna] of mapa) {
    const v = d[chave];
    if (v === undefined) continue;
    valores[coluna] = v === "" ? null : v;
    campos.push(coluna);
  }
  if (d.signup_liberado_por_padrao !== undefined) {
    valores.signup_liberado_por_padrao = d.signup_liberado_por_padrao;
    campos.push("signup_liberado_por_padrao");
  }
  if (campos.length === 0) return { ok: false, error: "nada_para_salvar" };

  // `upsert` e não `update`: a linha não existe numa instalação que nunca
  // cadastrou o App Secret, e um `update` casaria zero linhas devolvendo SUCESSO.
  const { error } = await createAdminClient()
    .from("platform_meta_app")
    .upsert({ id: 1, ...valores }, { onConflict: "id" });
  if (error) {
    return respostaParaOperador(error, { contexto: "[meta.signup] falha ao gravar a configuração" });
  }

  invalidarAppDaMeta();

  const cabecalhos = await headers();
  await audit({
    action: "platform_meta_app.signup_updated",
    actorUserId: authUser.id,
    // Sem `organizationId`: configuração da INSTALAÇÃO.
    resourceType: "platform_meta_app",
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: ipDoCliente(cabecalhos) ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    // QUAIS campos mudaram, jamais os valores.
    metadata: { campos },
  });

  return { ok: true };
}

/**
 * A liberação do canal oficial para UMA empresa.
 *
 * Aqui o `organization_id` vem do corpo, e isso é certo: quem chama é platform
 * admin escolhendo explicitamente a empresa na tela dele (não um tenant agindo em
 * si mesmo). A existência da empresa é conferida antes de gravar — sem isso um id
 * inventado cairia na FK com um erro de banco em vez de uma recusa legível.
 *
 * `null` em cada campo = "herda o padrão da instalação". `max_numeros` nulo = só o
 * limite do plano; `0` = nenhum número.
 */
const acessoSchema = z.object({
  organization_id: z.string().uuid(),
  embedded_signup: z.boolean().nullable(),
  coexistencia: z.boolean().nullable(),
  max_numeros: z.number().int().min(0).max(1000).nullable(),
});

export type AcessoDaEmpresaInput = z.infer<typeof acessoSchema>;

export async function definirAcessoDaEmpresaNaMeta(
  input: AcessoDaEmpresaInput,
): Promise<UpdateMetaSignupResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user: authUser } = escrita.ctx;

  const parsed = acessoSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }
  const d = parsed.data;

  const admin = createAdminClient();
  const { data: org, error: erroDaOrg } = await admin
    .from("organizations")
    .select("id")
    .eq("id", d.organization_id)
    .maybeSingle();
  if (erroDaOrg) {
    return respostaParaOperador(erroDaOrg, { contexto: "[meta.acesso] falha ao conferir a empresa" });
  }
  if (!org) return { ok: false, error: "empresa_nao_encontrada" };

  const { error } = await admin.from("organization_meta_access").upsert(
    {
      organization_id: d.organization_id,
      embedded_signup: d.embedded_signup,
      coexistencia: d.coexistencia,
      max_numeros: d.max_numeros,
      updated_by: authUser.id,
    },
    { onConflict: "organization_id" },
  );
  if (error) {
    return respostaParaOperador(error, { contexto: "[meta.acesso] falha ao gravar a liberação" });
  }

  const cabecalhos = await headers();
  await audit({
    action: "organization_meta_access.updated",
    actorUserId: authUser.id,
    organizationId: d.organization_id,
    resourceType: "organization_meta_access",
    resourceId: d.organization_id,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: ipDoCliente(cabecalhos) ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    metadata: {
      embedded_signup: d.embedded_signup,
      coexistencia: d.coexistencia,
      max_numeros: d.max_numeros,
    },
  });

  return { ok: true };
}
