import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Política de Privacidade — PING CHAT",
  description:
    "Como o PING CHAT trata dados de conta, do Instagram, de cobrança e das campanhas dos clientes.",
  alternates: {
    canonical: "https://www.pingchatbr.app/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Política de Privacidade"
      description="O PING CHAT ajuda criadores e negócios a responder comentários do Instagram com mensagens privadas, usando apenas a integração oficial da Meta."
      updatedAt="26 de novembro de 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-foreground">Quem somos</h2>
        <p className="mt-3">
          O PING CHAT é operado por Pereira Negócios Digitais LTDA, inscrita no CNPJ sob o nº 40.526.791/0001-02, estabelecida no Brasil.
        </p>
        <p className="mt-3">
          O site oficial do serviço é <a className="underline" href="https://www.pingchatbr.app">www.pingchatbr.app</a>. Para qualquer assunto sobre privacidade e proteção de dados, incluindo os direitos previstos na LGPD, escreva para <a className="underline" href="mailto:contato@pingchatbr.app">contato@pingchatbr.app</a>.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Dados que tratamos</h2>
        <p className="mt-3">
          Dados de cadastro: e-mail e, quando informado, nome de quem cria a conta ou é convidado para um espaço de trabalho.
        </p>
        <p className="mt-3">
          Dados da conta do Instagram conectada: identificador, nome de usuário e tokens de acesso, que são guardados cifrados.
        </p>
        <p className="mt-3">
          Dados das campanhas: configurações, mensagens, links, comentários e mensagens recebidos nas contas conectadas, registros de envio e eventos enviados pela Meta.
        </p>
        <p className="mt-3">
          Dados de cliques: contagem de cliques nos links das campanhas. Guardamos apenas versões irreversíveis (hash) do endereço IP e do destinatário, além do navegador e da página de origem.
        </p>
        <p className="mt-3">
          Dados de cobrança: plano, situação da assinatura e identificadores dos pagamentos. Dados de cartão são tratados diretamente pelo Asaas e não ficam nos nossos sistemas.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Para que usamos</h2>
        <p className="mt-3">
          Autenticar usuários, conectar contas do Instagram, identificar comentários que acionam campanhas, enviar respostas e mensagens privadas pela API oficial da Meta, evitar envios duplicados, medir resultados, cobrar assinaturas, diagnosticar falhas e proteger o serviço.
        </p>
        <p className="mt-3">
          Não vendemos dados pessoais e não os usamos para publicidade de terceiros.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Instagram e Meta</h2>
        <p className="mt-3">
          O PING CHAT não pede a senha do Instagram, não coleta dados por raspagem e não usa automação de navegador. Os tokens são usados somente para executar as ações autorizadas pela conta profissional conectada.
        </p>
        <p className="mt-3">
          Quem comenta ou envia mensagens para uma conta conectada tem seus dados tratados em nome do cliente dono daquela conta, que é o controlador desses dados. O PING CHAT atua como operador.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Com quem compartilhamos</h2>
        <p className="mt-3">
          Usamos fornecedores para operar o serviço, que tratam dados apenas na medida necessária: Meta (Instagram), Vercel (hospedagem), Supabase (banco de dados), Upstash (filas), Fly.io (processamento), Resend (e-mail) e Asaas (pagamentos). Alguns deles processam dados fora do Brasil.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Guarda e exclusão</h2>
        <p className="mt-3">
          Guardamos os dados enquanto a conta estiver ativa e pelo tempo necessário para cumprir obrigações legais, fiscais e de segurança. Desconectar o Instagram nas configurações remove a conexão guardada e interrompe as campanhas.
        </p>
        <p className="mt-3">
          Para excluir conta, espaço de trabalho ou dados de um contato, siga a página de <a className="underline" href="/data-deletion">exclusão de dados</a>.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Seus direitos</h2>
        <p className="mt-3">
          Você pode pedir confirmação do tratamento, acesso, correção, portabilidade, anonimização ou exclusão dos seus dados, além de informações sobre compartilhamento e a revogação de consentimento, conforme a Lei nº 13.709/2018 (LGPD). Envie o pedido para <a className="underline" href="mailto:contato@pingchatbr.app">contato@pingchatbr.app</a>. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Alterações</h2>
        <p className="mt-3">
          Podemos atualizar esta política. A data no topo indica a versão em vigor, e mudanças relevantes são avisadas aos clientes por e-mail.
        </p>
      </section>
    </LegalShell>
  );
}
