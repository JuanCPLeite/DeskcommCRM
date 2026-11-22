---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar o número oficial pela janela da Meta (Embedded Signup) com o app Tech Provider da instalação, com coexistência e vários números por empresa
---

Conectar o WhatsApp oficial exigia copiar três valores do painel da Meta (número,
conta e token) para cada empresa, e só dava para ter **um** número por empresa.

Agora quem administra a instalação cadastra uma vez, em
**Admin › API Oficial (Meta)**, o App ID do app de Tech Provider e os IDs das
configurações do Embedded Signup (número novo e coexistência). Cada empresa conecta o
próprio número numa janela da Meta — entra com o Facebook, escolhe o número e
confirma —, sem copiar token nenhum.

- **Coexistência.** O cliente mantém o número no aplicativo WhatsApp Business do
  celular enquanto o CRM também o usa. As mensagens que a empresa manda pelo
  aplicativo e os contatos da agenda do celular entram no CRM. Ao conectar, o CRM
  também pede à Meta o histórico das conversas, que ela só aceita pedir uma vez e
  em até 24 horas; a importação desse histórico para o CRM ainda não está pronta.
- **Vários números por empresa.** A conexão oficial deixa de assumir um número só:
  cada número é uma conexão própria, reconectar o mesmo número reaproveita a linha,
  e a tela lista todos.
- **Liberação por empresa.** Em **Admin › Empresas › API Oficial**, o administrador
  libera ou bloqueia, para cada cliente, o Embedded Signup e a coexistência, e define
  um teto de números que vale em cima do limite do plano. Por padrão,
  **nada fica liberado**: uma instalação que acabou de cadastrar o app não abre a
  conexão a todos os clientes sem ninguém decidir. Há um interruptor "liberar para
  todas por padrão".

Quem já tem o canal oficial conectado por token continua exatamente como estava: a
conexão manual segue disponível, e as conexões existentes não mudam.

O que fica para a conexão de um número real: o Embedded Signup só pode ser provado
de ponta a ponta com um app Tech Provider verificado pela Meta. Os passos do lado do
CRM — acesso da empresa, troca do código, prova de que o número é da conta, teto de
números, coexistência sem registrar o número — têm teste automatizado; o que a Meta
devolve de fato (validade do token, o número em coexistência) é conferido ao conectar
o primeiro número de teste.

Migration 9452 (aditiva): colunas novas em `platform_meta_app` e as tabelas
`organization_meta_access` e `channel_session_meta_signup`, ambas só do servidor.
