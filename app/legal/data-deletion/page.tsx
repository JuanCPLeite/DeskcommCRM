import type { Metadata } from "next";

import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolverOperador } from "@/lib/legal/operador";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Exclusão de dados" };

/**
 * Como excluir os dados trazidos do Instagram/Facebook (Meta). Página PÚBLICA: a Meta
 * pede uma URL com as instruções de exclusão para publicar o app, e a pessoa que quer
 * apagar os dados não tem sessão no CRM da empresa.
 */
export default async function DataDeletionPage() {
  const op = await resolverOperador();
  const idioma = await idiomaDoVisitante(null);
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Exclusão de dados")}</h1>
        <p className="text-muted-foreground">
          {t("Como apagar os dados do Instagram e do Facebook tratados por esta instalação do")} {op.sistema}.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("1. Se você é a empresa que conectou a conta")}</h2>
        <p>
          {t(
            "Em Conexões → Instagram, clique em Desconectar. O acesso à conta é apagado do servidor e o sistema deixa de receber as mensagens e os comentários dela.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("2. Se você é a pessoa que escreveu para uma conta")}</h2>
        <p>
          {t(
            "As mensagens e os comentários que você enviou ficam no atendimento da empresa dona da conta. Para pedir que sejam apagados ou anonimizados, escreva para a própria empresa, que é a responsável pelos dados, ou para o contato de privacidade abaixo, informando seu @usuário do Instagram.",
          )}
        </p>
        {op.dpoEmail ? (
          <p>
            {t("Contato de privacidade:")}{" "}
            <a className="underline underline-offset-2" href={`mailto:${op.dpoEmail}`}>
              {op.dpoEmail}
            </a>
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("3. Retirar o acesso pelo Instagram")}</h2>
        <p>
          {t(
            "Você também pode remover o app em Configurações do Instagram → Apps e sites. Isso encerra o acesso na hora; para apagar o que já foi recebido, siga o item 1 ou 2.",
          )}
        </p>
      </section>

      <p>
        <a className="underline underline-offset-2" href="/legal/privacy">
          {t("Política de Privacidade")}
        </a>
      </p>
    </>
  );
}
