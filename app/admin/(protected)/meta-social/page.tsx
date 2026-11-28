import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { appSocialDoAmbiente } from "@/lib/channels/meta-social/app";
import { env } from "@/lib/env";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDoAppSocial } from "./_form";

export const metadata = { title: "Instagram e Facebook da Meta da instalação" };
export const dynamic = "force-dynamic";

/**
 * Onde o dono da instalação cadastra o app Meta que conecta Instagram e
 * Facebook pelo login unificado: ID do app, ID da configuração do login, chave
 * secreta e token do webhook. Irmã de `/admin/meta` (WhatsApp oficial), pelo
 * mesmo motivo: o objeto é a INSTALAÇÃO, e deixar o admin de um tenant trocá-lo
 * derrubaria a entrada de todos.
 *
 * ⚠️ NENHUM SEGREDO VAI AO CLIENTE — nem cifrado. A leitura traz as colunas
 * cifradas só para saber SE existem; atravessam a fronteira booleanos, datas e
 * os dois identificadores públicos. O token em claro sai numa única resposta: a
 * da ação que acabou de gerá-lo.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const { data, error } = await createAdminClient()
    .from("platform_meta_social_app")
    .select("app_id, login_config_id, app_secret_encrypted, verify_token_encrypted, verify_token_created_at, updated_at")
    .eq("id", 1)
    .maybeSingle();

  const linha = data as
    | {
        app_id: string | null;
        login_config_id: string | null;
        app_secret_encrypted: string | null;
        verify_token_encrypted: string | null;
        verify_token_created_at: string | null;
        updated_at: string | null;
      }
    | null;

  const doAmbiente = appSocialDoAmbiente();
  const base = (env.META_WEBHOOK_BASE_URL.trim() || env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");

  return (
    <FormularioDoAppSocial
      appIdInicial={linha?.app_id ?? ""}
      loginConfigIdInicial={linha?.login_config_id ?? ""}
      temSegredoSalvo={Boolean(linha?.app_secret_encrypted)}
      temTokenSalvo={Boolean(linha?.verify_token_encrypted)}
      tokenGeradoEm={formatar(linha?.verify_token_created_at ?? null, usuario.idioma)}
      atualizadoEm={formatar(linha?.updated_at ?? null, usuario.idioma)}
      temNoAmbiente={Boolean(doAmbiente.appSecret && doAmbiente.verifyToken)}
      leituraFalhou={Boolean(error)}
      urlDoWebhook={`${base}/api/v1/webhooks/meta-social`}
      urlDeRedirecionamento={`${base}/auth/meta-social-return`}
    />
  );
}

function formatar(iso: string | null, idioma: Idioma): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(tagDeIdioma(idioma), {
    // Fuso fixo: a linha é da INSTALAÇÃO e formatar no cliente faria o HTML
    // servido e a hidratação divergirem.
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}
