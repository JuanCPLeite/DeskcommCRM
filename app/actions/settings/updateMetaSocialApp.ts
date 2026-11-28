"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { invalidarAppSocialDaMeta } from "@/lib/channels/meta-social/app";
import { respostaParaOperador } from "@/lib/erros/para-operador";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export type UpdateMetaSocialAppResult =
  /** `verifyToken` SÓ vem quando o token acabou de nascer — é a única vez que ele sai do servidor. */
  | { ok: true; verifyToken?: string }
  | { ok: false; error: string; details?: unknown };

/**
 * O app Meta SOCIAL (Instagram/Facebook) DESTA INSTALAÇÃO. Espelho declarado de
 * `updateMetaApp.ts`; as razões estão lá por inteiro e valem aqui:
 *  - gate de plataforma (o objeto é a instalação, não o tenant);
 *  - escrita pelo admin client (tabela de RLS ligada e zero policies);
 *  - verify token gerado pelo SERVIDOR, mostrado UMA vez, com rotação;
 *  - NUNCA em claro: sem cifra na instalação, a escrita recusa;
 *  - leitura que falhou NÃO é "nada gravado" (não gera token por cima do colado na Meta).
 *
 * Diferença: aqui os dois identificadores públicos (ID do app e da configuração
 * do login) também são salvos, e dá para trocá-los sem redigitar a chave secreta.
 */
const entradaSchema = z.object({
  appId: z.string().trim().max(64).optional(),
  loginConfigId: z.string().trim().max(64).optional(),
  // Opcional de propósito: vazio = "mantenha o gravado" (a tela nunca mostra a chave).
  appSecret: z.string().trim().min(16).max(300).optional(),
});

export type MetaSocialAppInput = z.infer<typeof entradaSchema>;

const SEM_CIFRA =
  "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o segredo não foi gravado";

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function gerarVerifyToken(): string {
  // base64url: o valor viaja em query string no handshake.
  return randomBytes(32).toString("base64url");
}

async function oQueEstaGravado(): Promise<
  { ok: true; temSegredo: boolean; temToken: boolean } | { ok: false; recusa: UpdateMetaSocialAppResult }
> {
  const { data, error } = await createAdminClient()
    .from("platform_meta_social_app")
    .select("app_secret_encrypted, verify_token_encrypted")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    logger.warn("[meta-social.app] não deu para ler o que está gravado; nada foi alterado", { codigo: error.code });
    return { ok: false, recusa: { ok: false, error: "leitura_do_app_falhou", details: { codigo: error.code } } };
  }
  const linha = data as { app_secret_encrypted?: string | null; verify_token_encrypted?: string | null } | null;
  return {
    ok: true,
    temSegredo: texto(linha?.app_secret_encrypted) !== "",
    temToken: texto(linha?.verify_token_encrypted) !== "",
  };
}

async function gravar(
  authUser: { id: string },
  valores: Record<string, unknown>,
  acao: "platform_meta_social_app.updated" | "platform_meta_social_app.verify_token_rotated",
  metadata: Record<string, unknown>,
): Promise<UpdateMetaSocialAppResult> {
  // `upsert`, não `update`: numa instalação que nunca configurou não há linha, e um
  // `update` casaria zero linhas devolvendo sucesso.
  const { error } = await createAdminClient()
    .from("platform_meta_social_app")
    .upsert({ id: 1, ...valores }, { onConflict: "id" });
  if (error) {
    return respostaParaOperador(error, { contexto: "[meta-social.app] falha ao gravar o app da instalação" });
  }
  invalidarAppSocialDaMeta();

  const cabecalhos = await headers();
  await audit({
    action: acao,
    actorUserId: authUser.id,
    // Sem `organizationId`: a credencial é da instalação, e carimbar a organização
    // ativa sugeriria uma mudança de cliente quando ela afeta todos.
    resourceType: "platform_meta_social_app",
    // `null`: `api_audit_log.resource_id` é uuid e a chave do singleton é 1.
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: ipDoCliente(cabecalhos) ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    // O QUE mudou, jamais o valor.
    metadata,
  });
  return { ok: true };
}

/** Salva os identificadores e, se vier, a chave; gera o verify token na primeira vez. */
export async function updateMetaSocialApp(input: MetaSocialAppInput): Promise<UpdateMetaSocialAppResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user: authUser } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  const gravado = await oQueEstaGravado();
  if (!gravado.ok) return gravado.recusa;

  const { appId, loginConfigId, appSecret } = parsed.data;
  const valores: Record<string, unknown> = { updated_by: authUser.id };
  const campos: string[] = [];

  // Identificadores: o que veio na entrada vale (vazio apaga). Só os que vieram.
  if (appId !== undefined) {
    valores.app_id = appId || null;
    campos.push("app_id");
  }
  if (loginConfigId !== undefined) {
    valores.login_config_id = loginConfigId || null;
    campos.push("login_config_id");
  }

  if (appSecret) {
    const cifrado = await encryptWebhookSecret(createAdminClient(), appSecret);
    if (!cifrado) return { ok: false, error: SEM_CIFRA };
    valores.app_secret_encrypted = cifrado;
    campos.push("app_secret_encrypted");
  }

  // O token só nasce quando já há (ou chega agora) a chave: sem ela ele nunca valeria.
  let verifyToken: string | undefined;
  if (!gravado.temToken && (gravado.temSegredo || appSecret)) {
    verifyToken = gerarVerifyToken();
    const cifrado = await encryptWebhookSecret(createAdminClient(), verifyToken);
    if (!cifrado) return { ok: false, error: SEM_CIFRA };
    valores.verify_token_encrypted = cifrado;
    valores.verify_token_created_at = new Date().toISOString();
    campos.push("verify_token_encrypted");
  }

  if (campos.length === 0) return { ok: false, error: "nada_para_salvar" };

  const r = await gravar(authUser, valores, "platform_meta_social_app.updated", {
    campos,
    segredo_trocado: Boolean(appSecret),
    verify_token_gerado: Boolean(verifyToken),
  });
  if (!r.ok) return r;
  return verifyToken ? { ok: true, verifyToken } : { ok: true };
}

/** Gera um verify token NOVO. O valor novo precisa ser colado no painel da Meta em seguida. */
export async function rotacionarVerifyTokenDoAppSocial(): Promise<UpdateMetaSocialAppResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user: authUser } = escrita.ctx;

  const gravado = await oQueEstaGravado();
  if (!gravado.ok) return gravado.recusa;
  if (!gravado.temSegredo) return { ok: false, error: "app_secret_obrigatorio" };

  const verifyToken = gerarVerifyToken();
  const cifrado = await encryptWebhookSecret(createAdminClient(), verifyToken);
  if (!cifrado) return { ok: false, error: SEM_CIFRA };

  const r = await gravar(
    authUser,
    {
      verify_token_encrypted: cifrado,
      verify_token_created_at: new Date().toISOString(),
      updated_by: authUser.id,
    },
    "platform_meta_social_app.verify_token_rotated",
    { campos: ["verify_token_encrypted"] },
  );
  if (!r.ok) return r;
  return { ok: true, verifyToken };
}
