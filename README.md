# UnoFin v1.0.1 — Aplicação Web Progressiva (PWA)

Aplicação de gestão financeira pessoal **100% local e privada** (sem servidores externos nem contas obrigatórias), concebida para funcionamento nativo em **iPhone (Safari)**, **Android (Chrome)** e **Computador (Windows / macOS / Linux)**.

## Como instalar e utilizar

### Opção 1 — Alojamento gratuito (GitHub Pages / Netlify / Vercel) — Recomendado para iPhone
Para que o Safari no iPhone permita instalar a aplicação no ecrã principal com armazenamento offline persistente:
1. Carrega o conteúdo desta pasta num repositório **GitHub** (ou arrasta a pasta para o **Netlify Drop**).
2. Abre o link HTTPS no **Safari** (iPhone) ou **Chrome** (Android / PC).
3. No iPhone: toca em **Partilhar** → **Adicionar ao ecrã principal**.
4. No Android / PC: toca em **Instalar aplicação** (ou no separador **Dados → Instalar como App**).

### Opção 2 — Execução local no computador
Como a aplicação utiliza módulos ES (`type="module"`), basta servi-la através de um servidor HTTP local simples na pasta onde extrair o ZIP:
```bash
python -m http.server 8080
```
Depois abre `http://localhost:8080` no navegador.

## Funcionalidades principais
- **Ciclos financeiros inteligentes**: abertura automática de ciclos com base na data de entrada do teu ordenado (com agrupamento configurável) e assistente de fecho de ciclo.
- **Gestão de cartões de crédito**: distinção visual entre despesas pagas em conta (barra sólida) e despesas virtuais a crédito (barra tracejada), controlo de plafond e liquidação.
- **Caderno de encargos mensal**: lista de contas fixas com cópia rápida de Entidade e Referência Multibanco e registo automático da despesa ao marcar como pago.
- **Importação de extratos PDF e CSV**: leitura local de extratos bancários com deteção automática de duplicados e aprendizagem de categorias.
- **Cópias de segurança JSON**: exportação e restauro completo dos dados em ficheiro `.json` a qualquer momento.
