import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { signupDaMeta } from "@/lib/channels/meta/signup-config";
import { createAdminClient } from "@/lib/supabase/admin";

import { AcessoDaEmpresaForm } from "./_form";

export const metadata = { title: "API Oficial da empresa" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Onde quem administra a instalação libera, para UMA empresa, o que o canal oficial
 * pode fazer: abrir o Embedded Signup, usar a coexistência e quantos números ter.
 *
 * ── Por que aqui, e não nos módulos opcionais ────────────────────────────────
 *
 * `/admin/modulos` tem a instalação como TETO (instalação desligada vence a empresa).
 * Quem revende precisa do contrário: desligado para a maioria e ligado só para o
 * cliente que contratou. A empresa é a exceção, em qualquer direção.
 *
 * Mesmo gate de `/admin/meta`: `notFound()` para quem não é platform admin, e o
 * layout de `(protected)` já roda `requirePlatformAdmin()`.
 */
export default async function Page({ params }: PageProps) {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const { id } = await params;
  const admin = createAdminClient();

  const { data: acesso, error } = await admin
    .from("organization_meta_access")
    .select("embedded_signup, coexistencia, max_numeros")
    .eq("organization_id", id)
    .maybeSingle();

  const signup = await signupDaMeta();

  const linha = acesso as
    | { embedded_signup: boolean | null; coexistencia: boolean | null; max_numeros: number | null }
    | null;

  // Banco anterior à 9452: a tabela não existe. Dizer isso é melhor que mostrar um
  // formulário que falharia ao salvar com um erro de banco.
  const bancoSemATabela = Boolean(error && ((error as { code?: string }).code === "42P01" || (error as { code?: string }).code === "PGRST205"));

  return (
    <AcessoDaEmpresaForm
      organizationId={id}
      embeddedSignup={linha?.embedded_signup ?? null}
      coexistencia={linha?.coexistencia ?? null}
      maxNumeros={linha?.max_numeros ?? null}
      padraoDaInstalacao={signup.liberadoPorPadrao}
      appConfigurado={Boolean(signup.appId && signup.configId)}
      bancoSemATabela={bancoSemATabela}
      leituraFalhou={Boolean(error) && !bancoSemATabela}
    />
  );
}
