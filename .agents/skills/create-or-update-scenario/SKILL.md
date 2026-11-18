---
name: create-or-update-scenario

description: >-
  Create, implement, review, refactor, or update visual scenarios for the
  Sonora project. Use this skill whenever a task involves defining a new
  scenario, changing an existing scenario's visual identity, composition,
  procedural generation, musical interpretation, feature-to-visual mappings,
  or scenario-specific behavior. Ensures compliance with Sonora's shared
  architecture, deterministic generation, musical synchronization, and
  technology stack.

argument-hint: "[operation] [scenario_id] [scenario_name] [scenario_description]"

disable-model-invocation: false
user-invocable: true

---

## Parameters

The skill accepts the following parameters. All parameters must be recognized,
including optional parameters. When a parameter is not provided, use its
documented default behavior. Ask the user for clarification only when the
missing information is necessary to proceed reliably.

### 1. operation

- **Required:** Yes
- **Type:** string
- **Allowed values:**
  - `create`: Create a new scenario.
  - `update`: Modify an existing scenario.
  - `review`: Review an existing scenario and identify inconsistencies,
    architectural violations, or improvement opportunities.
  - `refactor`: Restructure an existing scenario without necessarily changing
    its visual identity or intended behavior.
- **Default:** None.
- **Behavior:** Determines the main workflow executed by the skill.

### 2. scenario_name

- **Required:** No
- **Type:** string
- **Allowed values:** Any descriptive human-readable name.
- **Examples:** `Voxel Dreamscape`, `Cybernetic Cosmos`.
- **Default:** Derive from `scenario_id` or ask the user if the intended
  identity is unclear.
- **Behavior:** Defines the display name of the scenario.

### 3. scenario_description

- **Required:** Conditional
- **Type:** string
- **Allowed values:** Free-form natural language.
- **Default:** None.
- **Behavior:** Describes the intended visual identity, atmosphere,
  environment, and experience. Required for `create` unless the user has
  already established these details in the conversation.

### 4. visual_references

- **Required:** No
- **Type:** array of strings
- **Allowed values:** Image paths, URLs, descriptions, or references to
  previously supplied visual material.
- **Default:** Empty array.
- **Behavior:** Provides visual guidance for the scenario's appearance.
  References are inspirational constraints, not permission to disregard
  Sonora's architecture or technical limitations.

### 5. musical_mapping_strategy

- **Required:** No
- **Type:** string
- **Allowed values:**
  - `scenario_defined`: The scenario defines its own feature-to-visual mappings.
  - `user_guided`: The user provides or approves the main mappings.
  - `hybrid`: The skill proposes mappings and asks the user to validate
    important decisions.
- **Default:** `hybrid`.
- **Behavior:** Determines how musical features are associated with visual
  properties. It must never impose universal mappings across all scenarios.

### 6. visual_complexity

- **Required:** No
- **Type:** string
- **Allowed values:**
  - `low`: Simple geometry, limited effects, and restrained visual variation.
  - `medium`: Balanced geometry, environmental detail, and visual effects.
  - `high`: Complex procedural structures, richer effects, and greater
    environmental variation.
  - `very_high`: Maximum intended visual complexity, subject to performance
    constraints.
- **Default:** `medium`.
- **Behavior:** Establishes the intended visual complexity and guides
  implementation and performance decisions. It does not override runtime
  performance requirements.

### 7. implementation_scope

- **Required:** No
- **Type:** string
- **Allowed values:**
  - `documentation`: Define or update the scenario specification only.
  - `prototype`: Produce an initial functional implementation.
  - `full`: Implement the complete scenario within the existing architecture.
  - `incremental`: Implement only the explicitly requested portion.
- **Default:** `full`.
- **Behavior:** Defines how much implementation work should be performed.

### 8. additional_constraints

- **Required:** No
- **Type:** array of strings
- **Allowed values:** Free-form natural-language constraints.
- **Default:** Empty array.
- **Behavior:** Contains additional requirements, restrictions, preferences,
  or implementation details that are not represented by other parameters.
  These constraints cannot override the fixed rules of Sonora's architecture.
---

# Sonora Scenario Creator

## 1. Objetivo da Skill

Esta skill orienta a criação, implementação, revisão e atualização de cenários visuais do projeto Sonora.

O objetivo é permitir que a IA desenvolva cenários 3D proceduralmente gerados e sincronizados com música, respeitando a arquitetura compartilhada do Sonora.

A skill deve garantir que:

- Todos os cenários respeitem as mesmas regras fundamentais do Sonora.
- Cada cenário tenha liberdade para desenvolver sua própria identidade visual.
- Cada cenário possa escolher como interpretar as informações musicais disponíveis.
- A análise musical não seja duplicada ou implementada dentro dos cenários.
- A geração procedural seja determinística.
- A implementação seja modular, reutilizável e compatível com a arquitetura existente.
- Novos cenários possam ser criados sem modificar desnecessariamente os sistemas compartilhados.

A IA deve utilizar esta skill tanto para criar um cenário do zero quanto para atualizar um cenário existente.

---

## 2. Parâmetros de entrada

A IA deve identificar a intenção da solicitação e utilizar os parâmetros abaixo.

Os parâmetros podem ser informados diretamente pelo usuário, identificados nos arquivos do projeto ou definidos durante a conversa.

Não pergunte novamente informações que já estejam disponíveis.

### 2.1 Parâmetros principais

- `operation`
  - `create`: criar um cenário novo.
  - `update`: atualizar um cenário existente.
  - `review`: revisar um cenário sem necessariamente modificar sua implementação.
  - `refactor`: reorganizar a implementação de um cenário preservando seu comportamento.

- `scenario_id`
  - Identificador estável do cenário.
  - Obrigatório para `update`, `review` e `refactor`.
  - Para `create`, deve ser proposto caso não seja informado.

- `scenario_name`
  - Nome de apresentação do cenário.
  - Pode ser proposto pela IA quando não informado.

- `scenario_description`
  - Descrição geral da experiência visual desejada.
  - Pode ser fornecida por texto, referências visuais ou ambos.

- `visual_references`
  - Imagens, conceitos artísticos, descrições ou referências que definam a direção visual.
  - Opcional.
  - Se não houver referências, a IA pode propor uma direção visual com base na descrição do usuário.

- `musical_mapping_strategy`
  - Estratégia de interpretação musical.
  - Pode ser definida livremente pelo cenário.
  - Não deve existir um mapeamento universal obrigatório entre features musicais e propriedades visuais.

- `visual_complexity`
  - Nível de complexidade visual desejado.
  - Valores: `low`, `medium`, `high`, `very_high` (mesmos do cabeçalho da skill).
  - Se não informado, usar `medium`.

- `implementation_scope`
  - `documentation`: definir ou atualizar apenas a especificação do cenário.
  - `prototype`: produzir uma primeira implementação funcional.
  - `full`: implementar o cenário completo (padrão).
  - `incremental`: implementar apenas a parte explicitamente solicitada.

- `additional_constraints`
  - Restrições específicas fornecidas pelo usuário.

### 2.2 Comportamento quando faltarem parâmetros

A IA deve seguir estas regras:

1. Consultar primeiro o contexto da conversa e os arquivos do projeto.
2. Preencher automaticamente informações que já estejam documentadas.
3. Propor valores razoáveis quando a escolha não for crítica.
4. Perguntar ao usuário quando uma decisão ausente alterar significativamente a identidade, o comportamento ou o escopo do cenário.
5. Não perguntar sobre regras globais que já estejam definidas nesta skill.
6. Não exigir que o usuário defina individualmente todos os mapeamentos musicais.
7. Apresentar propostas identificadas como propostas, nunca como decisões já aprovadas.

Quando houver várias decisões independentes pendentes, agrupar as perguntas em uma única etapa objetiva.

---

# 3. Regras fixas para todos os cenários

Esta seção contém as regras globais do Sonora.

A IA deve respeitar estas regras ao criar, modificar ou revisar qualquer cenário.

Nenhum cenário pode redefinir unilateralmente essas responsabilidades.

## 3.1 Separação entre análise musical e interpretação visual

A análise musical é compartilhada por todos os cenários.

O sistema central do Sonora é responsável por:

- Processar o áudio.
- Extrair informações do sinal.
- Identificar características rítmicas.
- Estimar informações estruturais e interpretativas.
- Construir uma representação temporal da música.
- Disponibilizar as informações para os cenários.

O cenário é responsável por interpretar essas informações e transformá-las em parâmetros visuais.

Fluxo conceitual obrigatório:

Music Analysis Engine
    |
    v
Musical Timeline
    |
    v
Scenario Interpretation
    |
    v
Scenario Visual Parameters
    |
    v
World Generation / Visual Systems
    |
    v
Rendering

Um cenário não deve:

- Implementar seu próprio pipeline de análise de áudio.
- Duplicar o cálculo de BPM, RMS, espectro ou transientes.
- Criar uma interpretação musical global que deveria pertencer ao Music Intelligence Engine.
- Fazer o renderer interpretar diretamente o áudio bruto.
- Tornar o sistema de análise dependente de um cenário específico.

O cenário pode solicitar novas informações musicais quando houver uma necessidade real, mas deve propor a extensão ao sistema compartilhado em vez de criar uma implementação isolada.

## 3.2 Catálogo compartilhado de informações musicais

Todos os cenários devem consumir as informações disponibilizadas pelo sistema central.

As informações musicais estão organizadas em três categorias.

### A. Informações reativas

Incluem:

- Amplitude e volume.
- RMS e energia do sinal.
- Espectro e características espectrais.
- Energia de bandas de frequência.
- Transientes e impactos.

### B. Informações rítmicas

Incluem:

- BPM estimado.
- Posições das batidas.
- Compassos, quando inferíveis.
- Subdivisões rítmicas, quando inferíveis.
- Padrões e impactos rítmicos.

### C. Informações interpretativas

Incluem estimativas de:

- Seções e mudanças estruturais.
- Introduções, quando detectáveis.
- Transições.
- Pausas.
- Clímax e aumentos significativos de intensidade.
- Tensão e calmaria.
- Contrastes e mudanças inesperadas.

A disponibilidade e confiabilidade de cada informação devem ser consideradas.

Uma estimativa musical não deve ser tratada como verdade absoluta.

O cenário deve tolerar informações ausentes, imprecisas ou com baixa confiança.

### Regra fundamental

A existência de uma informação musical não significa que ela precise ser utilizada por todos os cenários.

Cada cenário escolhe quais informações fazem sentido para sua própria identidade.

## 3.3 Catálogo compartilhado de capacidades visuais

O Sonora deve oferecer sistemas visuais que possam ser utilizados pelos cenários.

Entre as categorias possíveis estão:

- Geometry: geometria, dimensões, formas e deformações.
- Architecture: construções, estruturas e composição espacial.
- Materials: materiais, superfícies e propriedades visuais.
- Colors: paletas, cores e variações cromáticas.
- Lighting: iluminação, intensidade, cor e distribuição.
- Particles: partículas, emissão, movimento e comportamento.
- Atmosphere: neblina, ambiente, profundidade e efeitos atmosféricos.
- Environment: terreno, céu, horizonte e elementos ambientais.
- Motion: movimento, oscilação e transformações.
- Effects: efeitos visuais e pós-processamento.

Essa lista é um catálogo conceitual de capacidades, não uma exigência de que todos os sistemas já estejam implementados.

A IA deve consultar a arquitetura e o código existentes antes de assumir que uma capacidade está disponível.

Se o cenário precisar de uma nova capacidade visual:

1. Identificar a necessidade.
2. Verificar se existe um sistema compartilhado que possa atendê-la.
3. Reutilizar o sistema existente quando adequado.
4. Se não existir, propor a criação de uma capacidade compartilhada ou de uma implementação específica do cenário.
5. Explicar a decisão e evitar duplicação desnecessária.

O catálogo visual deve ser extensível.

## 3.4 Ausência de mapeamentos musicais universais

Não existem relações visuais obrigatórias entre uma feature musical e uma propriedade visual.

Exemplos de relações que NÃO devem ser consideradas regras globais:

- Graves sempre controlam iluminação.
- RMS sempre controla tamanho da geometria.
- BPM sempre controla velocidade.
- Transientes sempre geram partículas.
- Clímax sempre aumenta o brilho.
- Frequências altas sempre controlam cores.

Essas relações podem fazer sentido em determinado cenário, mas não são obrigatórias.

Cada cenário define sua própria gramática visual.

## 3.5 Determinismo

Todos os cenários devem respeitar o sistema de identidade e geração determinística do Sonora.

A identidade do mundo considera:

- Hash SHA-256 do PCM canônico.
- Identificador do cenário.
- Versão do cenário.
- Versão da geração do mundo.

O cenário deve participar dessa identidade por meio de seu identificador e versão.

A geração procedural deve utilizar entradas estáveis e aleatoriedade controlada por seed.

Não utilizar aleatoriedade não determinística para decisões que alterem a identidade do mundo.

Quando houver elementos aleatórios, utilizar uma fonte pseudoaleatória baseada em seed.

A geração de segmentos e subsistemas deve ser reproduzível.

Não depender de:

- FPS.
- Ordem incidental de execução.
- Histórico de frames.
- Estado global aleatório.
- Momento em que um segmento foi carregado.

## 3.6 Reconstrução temporal

O estado visual do mundo deve ser reconstruível em qualquer timestamp.

Para um mesmo conjunto de entradas e um mesmo instante `t`, o cenário deve produzir o mesmo resultado.

Sempre que possível, animações, partículas e transformações devem ser calculadas a partir de:

- Tempo absoluto da música.
- Seed determinística.
- Informações da timeline.
- Configuração do cenário.

Não depender exclusivamente da acumulação de alterações frame a frame.

O cenário não deve impedir que o mundo seja reconstruído em um timestamp arbitrário.

## 3.7 Pré-análise e análise em tempo real

O Sonora combina:

- Pré-análise da faixa completa.
- Análise complementar durante a reprodução.

Decisões importantes de geometria e estrutura do mundo devem utilizar informações determinísticas estabelecidas durante a pré-análise e geração.

A análise em tempo real pode complementar o comportamento visual com variações menores e responsivas.

Não permitir que pequenas variações de processamento em tempo real reorganizem imprevisivelmente a geometria principal do cenário.

## 3.8 Estrutura procedural segmentada

O mundo é dividido em segmentos procedurais.

Todos os cenários devem respeitar o sistema compartilhado de segmentos:

- Cada segmento possui posição estável.
- Cada segmento possui identidade e seed determinísticas.
- Segmentos à frente da câmera são preparados antecipadamente.
- Segmentos suficientemente distantes atrás da câmera podem ser descartados.
- Um segmento recriado deve preservar o mesmo resultado para as mesmas entradas.

O cenário pode definir como seus segmentos são compostos, mas não deve criar um sistema de streaming independente sem necessidade e justificativa arquitetural.

## 3.9 Câmera e experiência

A câmera é compartilhada pela experiência do Sonora.

Regras fixas do MVP:

- A câmera representa a perspectiva do usuário.
- A câmera avança continuamente em linha reta.
- A direção de deslocamento é independente da direção do olhar.
- O usuário pode olhar horizontalmente até 45 graus para cada lado.
- O usuário pode olhar verticalmente até 45 graus para cima ou para baixo.
- Os limites horizontal e vertical são independentes.
- O cenário não deve transformar a câmera em um personagem controlável.
- Elementos como veículos, criaturas ou personagens podem existir, mas são secundários.

O cenário pode influenciar a composição visual ao redor da câmera, mas não deve alterar essas regras.

## 3.10 Responsabilidade do renderer

O renderer deve receber parâmetros e estados visuais resolvidos.

Ele não deve ser responsável por:

- Interpretar o significado musical.
- Definir prioridades de features.
- Escolher mapeamentos específicos do cenário.
- Criar decisões procedurais não determinísticas.

O renderer deve se concentrar na representação visual dos dados recebidos.

## 3.11 Stack tecnológica fixa

A implementação dos cenários deve respeitar a stack aprovada:

- TypeScript.
- React.
- Vite.
- npm.
- Three.js.
- WebGL 2.
- GLSL ES 3.00.

Three.js deve permanecer independente do ciclo de renderização de componentes React.

React Three Fiber não faz parte da stack inicial aprovada.

WebGPU não faz parte da implementação inicial.

Shaders customizados devem utilizar GLSL ES 3.00.

Não introduzir outra tecnologia de renderização ou framework sem apresentar justificativa e identificar a mudança como proposta arquitetural.

## 3.12 Execução e desempenho

O processamento de análise musical, inteligência musical, geração procedural e renderização ocorre no dispositivo do usuário.

O backend auxiliar possui responsabilidade limitada à aquisição e entrega do áudio.

Um cenário não deve transferir análise musical ou renderização para o backend.

A implementação deve considerar:

- Reutilização de geometrias e materiais.
- Uso de instancing quando apropriado.
- Controle de alocações.
- Descarte correto de recursos.
- Uso consciente de shaders.
- Efeitos visuais proporcionais ao benefício.
- Consumo de memória e GPU.

Não adicionar complexidade de otimização sem necessidade comprovada.

## 3.13 Estrutura de todo cenário: assinatura e grupos visuais

O **conteúdo** de cada cenário é livre (seção 3.4), mas a **estrutura** é fixa:
todo cenário é composto por uma **assinatura** e por **grupos visuais**.
O cenário Synthwave (`src/scenarios/synthwave/`) é a implementação de
referência desta estrutura (ver seção 12). Ele ilustra a estrutura e o nível de
acabamento esperados, não o conteúdo: nenhum mapeamento dele é regra para outros
cenários.

### Assinatura do cenário

- Cada cenário tem **uma** característica central que o define e que é afetada
  pela música de um jeito próprio. No Synthwave é a estrada: subir, descer e
  variar de velocidade.
- A assinatura é **estrutural e lenta**: deriva da pré-análise (timeline
  inteira), é determinística e time-addressable, e pertence à geração
  (`createPath`, `generateSegment`), nunca a um pulso ao vivo.
- A assinatura é específica do cenário. Outro cenário pode não ter estrada,
  subidas, descidas ou montanhas. Não copiar a assinatura de um cenário
  existente; propor uma característica que faça sentido para a nova identidade
  (por exemplo: a água de um oceano, a densidade de um corredor, a gravidade de
  plataformas flutuantes).
- A assinatura deve ser reconhecível só pelo movimento, mesmo sem ver as cores.

### Grupos visuais

- O mundo é dividido em **grupos visuais** distintos e identificáveis (no
  Synthwave: estrada, montanhas, chão/grade, céu, estrelas, brasas, cidade).
- Cada grupo reage a **uma característica principal** do áudio (seu *driver*),
  escolhida pelo que a característica representa musicalmente e por como o
  grupo se comporta visualmente. Exemplo no Synthwave: o tamanho das montanhas
  segue a energia da faixa; a estrada segue a intensidade.
- Grupos diferentes devem ter drivers diferentes, ou a mesma feature em escalas
  de tempo diferentes (estrutural/baked vs. pulso ao vivo). Se todos os grupos
  reagem à mesma feature, o cenário vira um visualizador de áudio convencional.
- Um grupo pode ter drivers secundários (as estrelas do Synthwave têm três
  populações, uma por banda), desde que o driver principal esteja explícito e a
  combinação siga a seção 4.6.
- Todo cenário também tem elementos **independentes da música** (vida ambiental,
  como as janelas do Synthwave em relógio próprio): a música modula o grupo, não
  é a única fonte de movimento.
- Cada grupo é isolado no código: material/mesh/uniforms próprios na cena, e
  campos próprios, agrupados e comentados, nos `Params` da lógica. Alterar um
  grupo não deve exigir tocar nos outros.
- Separar, em cada grupo, o que é **baked** (decidido na geração a partir da
  timeline: forma, tamanho, altura) do que é **ao vivo** (pulso, brilho,
  densidade calculados por `interpret`), conforme a seção 3.7.

---

# 4. Configurações dinâmicas de cada cenário

Esta seção contém as decisões que podem variar entre cenários.

A IA deve permitir que cada cenário escolha suas próprias características, sem assumir que existe uma configuração padrão universal.

## 4.1 Identidade visual

Cada cenário deve definir:

- Nome.
- Descrição.
- Conceito artístico.
- Estilo visual.
- Paleta de cores.
- Materiais predominantes.
- Formas e geometrias características.
- Atmosfera.
- Elementos ambientais.
- Escala e densidade visual.
- Referências visuais, quando disponíveis.

A IA pode propor esses elementos quando o usuário fornecer apenas uma ideia geral.

## 4.2 Composição do mundo

Cada cenário pode escolher:

- Tipo de ambiente.
- Organização espacial.
- Elementos principais.
- Elementos secundários.
- Distribuição de estruturas.
- Densidade de objetos.
- Variação de altura e profundidade.
- Distribuição de espaços vazios.
- Elementos próximos e distantes.
- Organização dos segmentos.
- Transições entre segmentos.

Não existe uma composição espacial obrigatória para todos os cenários.

## 4.3 Seleção de informações musicais

Cada cenário deve escolher quais informações musicais serão utilizadas.

A IA deve avaliar a relevância de cada feature para a identidade visual.

Para cada informação selecionada, registrar:

- Feature utilizada.
- Motivo da escolha.
- Sistema visual que poderá ser influenciado.
- Prioridade.
- Intensidade de influência.
- Comportamento esperado.
- Necessidade de suavização.
- Comportamento em caso de ausência ou baixa confiança.

O cenário pode ignorar qualquer feature que não contribua para sua experiência.

Não é necessário utilizar todas as informações disponíveis.

## 4.4 Seleção de propriedades visuais

Cada cenário deve definir quais propriedades visuais fazem parte de sua experiência.

Exemplos:

Geometry:
- Altura.
- Largura.
- Escala.
- Deformação.
- Densidade.
- Complexidade.

Architecture:
- Quantidade de estruturas.
- Distribuição.
- Altura de construções.
- Organização espacial.
- Transformações estruturais.

Lighting:
- Intensidade.
- Cor.
- Alcance.
- Direção.
- Pulsação.
- Frequência de variação.

Particles:
- Quantidade.
- Emissão.
- Velocidade.
- Tamanho.
- Cor.
- Trajetória.

Atmosphere:
- Densidade de neblina.
- Cor do ambiente.
- Visibilidade.
- Profundidade.
- Intensidade atmosférica.

Motion:
- Oscilação.
- Rotação.
- Deformação temporal.
- Velocidade de animações.
- Frequência de movimentos.

Esses exemplos não representam propriedades obrigatórias nem confirmam que todos esses parâmetros já existam no código.

A IA deve verificar a implementação antes de utilizá-los.

## 4.5 Matriz de interpretação musical

A principal configuração dinâmica de um cenário é sua matriz de interpretação.

Ela define como as informações musicais são convertidas em parâmetros visuais.

A matriz deve ser criada individualmente para cada cenário.

Estrutura conceitual:

| Campo | Descrição |
|---|---|
| musical_feature | Informação musical de origem |
| visual_target | Propriedade visual de destino |
| priority | Prioridade da relação |
| influence | Intensidade da influência |
| response_curve | Curva de resposta |
| smoothing | Suavização |
| min_value | Limite inferior |
| max_value | Limite superior |
| response_speed | Velocidade de resposta |
| confidence_threshold | Confiança mínima necessária |
| fallback | Comportamento quando a informação não está disponível |
| notes | Justificativa e observações |

Os campos acima são um modelo conceitual.

A implementação final deve respeitar os tipos e contratos existentes no projeto.

### Prioridades

A prioridade define a importância de uma relação musical dentro do cenário.

A IA pode utilizar uma escala numérica ou categorias, desde que mantenha consistência dentro do cenário.

Exemplo de escala proposta:

- `critical`: influencia fortemente a identidade do cenário.
- `high`: influência importante.
- `medium`: influência complementar.
- `low`: detalhe visual.
- `disabled`: relação não utilizada.

Não existe uma ordem universal de prioridades entre cenários.

### Influência

A influência define quanto uma feature altera uma propriedade visual.

Pode ser configurada com valores normalizados ou parâmetros adequados ao sistema visual.

A IA deve evitar valores arbitrários sem explicar sua finalidade.

### Curva de resposta

Cada relação pode escolher sua própria curva de resposta.

Exemplos:

- Linear.
- Exponencial.
- Logarítmica.
- Threshold.
- Smoothstep.
- Curva customizada.

A escolha depende do comportamento visual desejado.

### Suavização

Cada relação pode escolher sua própria suavização.

Exemplos:

- Sem suavização.
- Interpolação linear.
- Interpolação exponencial.
- Média temporal.
- Envelope de ataque e release.

A suavização deve evitar oscilações visuais indesejadas sem remover a identidade rítmica da música.

### Limites

Cada relação pode definir valores mínimos e máximos para impedir resultados visualmente inadequados.

Os limites devem considerar a escala e o significado real do parâmetro de destino.

### Confiança

Quando a informação musical possuir um indicador de confiança, o cenário poderá definir como utilizá-lo.

Exemplos:

- Ignorar eventos com confiança muito baixa.
- Reduzir a intensidade da influência.
- Utilizar um comportamento alternativo.
- Manter o último valor determinístico válido, quando apropriado.

Não inventar confiança para features que não a disponibilizam.

## 4.6 Relações entre várias features

Uma propriedade visual pode receber influência de mais de uma feature.

Exemplos conceituais:

- Iluminação influenciada por energia e transientes.
- Geometria influenciada por energia de longo prazo e mudanças estruturais.
- Movimento influenciado por BPM e subdivisões.
- Atmosfera influenciada por tensão e calmaria.

Essas relações devem ser definidas pelo cenário.

Quando várias features influenciam a mesma propriedade, a IA deve especificar como combinar as contribuições.

Possibilidades:

- Soma ponderada.
- Multiplicação.
- Máximo ou mínimo.
- Prioridade dominante.
- Camadas independentes.
- Função de combinação customizada.

A IA deve verificar se a combinação produz comportamento estável e previsível.

Não permitir que várias regras disputem o mesmo parâmetro sem uma estratégia explícita de resolução.

## 4.7 Elementos e comportamentos exclusivos

Cada cenário pode possuir sistemas que não existem em outros cenários.

Exemplos:

- Estruturas que se reorganizam.
- Elementos que surgem em determinados eventos musicais.
- Arquitetura que muda durante transições.
- Criaturas ou veículos ambientais.
- Efeitos de distorção.
- Mudanças de horizonte.
- Elementos que acompanham padrões rítmicos.
- Eventos visuais associados a clímax.

Esses comportamentos podem ser específicos do cenário.

Entretanto, devem respeitar determinismo, sincronização, desempenho e limites de responsabilidade.

Se uma funcionalidade puder ser reutilizada por outros cenários, a IA deve avaliar se ela merece ser promovida a um sistema compartilhado.

## 4.8 Configuração procedural

Cada cenário pode definir:

- Regras de composição.
- Famílias de objetos.
- Regras de distribuição.
- Variações geométricas.
- Densidade.
- Regras de posicionamento.
- Regras de transição.
- Uso de seeds secundárias.
- Comportamento de cada segmento.

A geração deve ser baseada em entradas determinísticas.

A IA deve distinguir parâmetros de composição estáticos de parâmetros que variam ao longo da música.

---

# 5. Processo para criar um cenário

Quando `operation=create`, seguir a sequência abaixo.

## Etapa 1 — Consultar o projeto

Antes de implementar:

1. Ler `PRODUCT_SPEC.md` (em `docs/`).
2. Ler `TECH_STACK.md` (em `docs/`).
3. Ler `TECHNICAL_ARCHITECTURE.md` (em `docs/`).
4. Consultar as instruções de desenvolvimento do repositório, como `AGENTS.md`, quando disponíveis.
5. Inspecionar a estrutura atual do código.
6. Identificar cenários já existentes.
7. Identificar os contratos e sistemas compartilhados disponíveis.
8. Identificar quais capacidades visuais já estão implementadas.

Não assumir que a documentação representa necessariamente o estado atual do código.

Quando houver divergência, identificar a divergência e não modificar silenciosamente decisões aprovadas.

## Etapa 2 — Definir identidade visual

Com as informações disponíveis, produzir uma proposta contendo:

- Nome.
- Identificador.
- Descrição.
- Conceito visual.
- Paleta.
- Geometria.
- Materiais.
- Ambiente.
- Composição.
- Elementos principais.
- Elementos secundários.

Se o usuário já forneceu referências suficientes, não perguntar novamente.

Se faltar uma decisão que altere substancialmente a identidade visual, perguntar antes de implementar.

## Etapa 2.1 — Definir a assinatura e os grupos visuais (portão de aprovação)

Esta etapa é obrigatória e vem **antes de escrever código**. Aplicar a seção
3.13.

1. Ler as features realmente disponíveis em `TRACK_NAMES`
   (`src/audio/intelligence/timeline.ts`) e o que a pré-análise já oferece
   (por exemplo `timeline.evaluate`, `musicEndFrame`). Não propor uma feature
   que não exista; se for necessária, propor a extensão do sistema compartilhado.
2. Propor a **assinatura** do cenário: qual característica é central, qual
   feature/intensidade musical a controla, e como isso aparece na geração
   (path, forma do terreno, densidade, etc.).
3. Propor a lista de **grupos visuais**, em uma tabela:

   | Grupo | Papel visual | Driver principal | Baked ou ao vivo | Elementos independentes da música |
   |---|---|---|---|---|

4. Verificar que a assinatura e os grupos não repetem o mesmo driver sem motivo
   e que existe pelo menos um grupo de fundo, um de meio e um próximo à câmera
   (profundidade).
5. Marcar tudo como `PROPOSED` e **pedir validação do usuário** (estratégia
   `hybrid`) antes de implementar. Em `user_guided`, usar os grupos e drivers
   que o usuário informar. Em `scenario_defined`, seguir sem perguntar, mas
   registrar a tabela na entrega.

Não implementar um cenário "básico" para o usuário refinar depois. A primeira
entrega deve já ter a assinatura e todos os grupos aprovados, com o acabamento
descrito na seção 12.

## Etapa 3 — Definir composição do mundo

Descrever:

- Organização espacial.
- Elementos recorrentes.
- Distribuição de objetos.
- Relação entre estruturas.
- Organização dos segmentos.
- Variações possíveis.
- Transições entre áreas.

A composição deve ser coerente com a identidade visual.

## Etapa 4 — Selecionar features musicais

Analisar o catálogo compartilhado e escolher as features que fazem sentido.

Para cada feature selecionada, explicar:

- Por que será utilizada.
- O que representa para o cenário.
- Quais comportamentos visuais pode influenciar.

Não criar mapeamentos apenas para preencher uma tabela.

## Etapa 5 — Definir propriedades visuais

Selecionar as propriedades que realmente fazem parte do cenário.

Separar:

- Propriedades estruturais.
- Propriedades reativas.
- Propriedades rítmicas.
- Propriedades interpretativas.
- Propriedades independentes da música.

## Etapa 6 — Construir a matriz de interpretação

Definir as relações entre features musicais e propriedades visuais.

Para cada relação, definir:

- Prioridade.
- Influência.
- Curva de resposta.
- Suavização.
- Limites.
- Velocidade de resposta.
- Tratamento de confiança.
- Fallback.

Verificar conflitos entre relações que controlam a mesma propriedade.

## Etapa 7 — Definir comportamento temporal

Descrever como o cenário reage a:

- Música calma.
- Aumento gradual de energia.
- Batidas.
- Transientes.
- Transições.
- Pausas.
- Clímax.
- Mudanças estruturais.

Esses comportamentos devem ser descritos como respostas possíveis do cenário, não como regras musicais universais.

Considerar também o que acontece quando uma feature está indisponível.

## Etapa 8 — Planejar implementação

Antes de alterar o código, apresentar ou construir um plano técnico coerente com o repositório.

Identificar:

- Arquivos novos.
- Arquivos existentes que precisam ser alterados.
- Interfaces necessárias.
- Sistemas compartilhados que serão reutilizados.
- Recursos visuais necessários.
- Sistemas exclusivos do cenário.
- Estratégia de geração procedural.
- Estratégia de sincronização.
- Estratégia de testes.

Evitar criar abstrações genéricas prematuras.

## Etapa 9 — Implementar

Implementar o cenário utilizando os contratos existentes.

Manter separação entre:

- Identidade e configuração.
- Interpretação musical.
- Geração procedural.
- Composição visual.
- Renderização.

Não colocar toda a implementação em um único componente ou arquivo.

Não duplicar sistemas compartilhados.

Não alterar outros cenários sem necessidade.

Organização obrigatória do código (seguindo `src/scenarios/synthwave/`):

- `logic.ts` (puro, sem Three.js nem DOM): constantes tipadas do cenário,
  interface do segmento, interface `Params` com os campos **agrupados por
  grupo visual e comentados** com o driver de cada um, `interpret` organizado na
  mesma ordem dos grupos, `generateSegment` e, quando a assinatura exigir, o
  `createPath` ou equivalente.
- Arquivos puros adicionais (como `path.ts`) para a assinatura quando ela for
  complexa. Nada de aleatoriedade fora de `deriveSeed`/`rand`/`rand2`.
- `scene.ts` (Three.js, thread principal): um material/mesh por grupo, uniforms
  atualizados por grupo em `update`, descarte completo em `dispose`.
- Registro em `registry.ts` (cena) e `logics.ts` (lógica para o Worker).
- Comentário de histórico de versões ao lado de `version` em `logic.ts`,
  descrevendo cada mudança que altera o mundo gerado.

Acabamento esperado (ver seção 12): continuidade de distância (LOD/campo
distante quando a vista for longa), neblina na mesma cor do céu, vida ambiental
independente da música e animação por tempo da faixa em vez de estado por frame.

## Etapa 10 — Validar

Executar as verificações possíveis:

- Compatibilidade com os contratos do projeto.
- Compilação TypeScript.
- Build Vite.
- Testes automatizados existentes.
- Determinismo.
- Reconstrução temporal.
- Comportamento com features ausentes.
- Comportamento com baixa confiança.
- Limites visuais.
- Descarte de recursos.
- Desempenho.

- Cada grupo visual reage ao seu driver (sem depender de outro grupo).
- A assinatura é determinística e time-addressable (mesmo `t`, mesmo resultado).

- Os padrões de bugs conhecidos (seção 13) não se repetem.

Não afirmar que uma validação foi executada se ela não foi realmente realizada.

## Etapa 11 — Documentar

Registrar:

- Identidade do cenário.
- Versão.
- Descrição visual.
- Capacidades utilizadas.
- Features selecionadas.
- Matriz de interpretação.
- Comportamentos temporais.
- Decisões técnicas específicas.
- Limitações conhecidas.

Identificar cada decisão como:

- `DECIDED`
- `PROPOSED`
- `OPEN`

Não promover propostas a decisões aprovadas sem autorização.

---

# 6. Processo para atualizar um cenário

Quando `operation=update`, seguir as etapas abaixo.

## 6.1 Inspecionar o estado atual

Antes de modificar:

1. Localizar a implementação do cenário.
2. Ler sua documentação.
3. Identificar sua versão.
4. Identificar seus sistemas exclusivos.
5. Identificar suas dependências compartilhadas.
6. Entender seus mapeamentos musicais.
7. Identificar testes existentes.

Não reconstruir o cenário do zero sem necessidade.

## 6.2 Classificar a alteração

Classificar a solicitação em uma ou mais categorias:

- Identidade visual.
- Composição do mundo.
- Geometria.
- Materiais.
- Cores.
- Iluminação.
- Partículas.
- Atmosfera.
- Movimento.
- Mapeamento musical.
- Prioridades.
- Comportamento temporal.
- Geração procedural.
- Desempenho.
- Arquitetura.
- Correção de bugs.
- Assinatura do cenário.
- Grupos visuais (novo grupo, remoção ou troca de driver).

Ao adicionar ou alterar um grupo, aplicar a seção 3.13: driver explícito,
isolamento no código e distinção entre baked e ao vivo.

## 6.3 Preservar o que não foi solicitado

Uma atualização deve preservar:

- A identidade visual não relacionada à solicitação.
- Os comportamentos que continuam válidos.
- As regras globais.
- A compatibilidade com os sistemas compartilhados.
- O determinismo.
- A sincronização.

Não alterar características do cenário apenas porque a IA prefere outra solução.

## 6.4 Avaliar impacto

Antes de implementar, identificar se a alteração afeta:

- Apenas o cenário.
- Um sistema visual compartilhado.
- O catálogo de capacidades visuais.
- O catálogo de informações musicais.
- A arquitetura global.
- A identidade determinística.
- Outros cenários.

Mudanças locais devem permanecer locais sempre que possível.

Mudanças globais exigem justificativa e avaliação de impacto.

## 6.5 Versionamento

Se uma alteração modificar a geração ou a identidade do mundo, avaliar a necessidade de atualizar a versão do cenário.

A versão deve refletir mudanças relevantes para a identidade e reprodução do cenário.

Não atualizar versões automaticamente para qualquer ajuste cosmético sem avaliar as regras de versionamento existentes.

Se a estratégia de versionamento ainda não estiver definida, registrar a decisão como `OPEN` ou `PROPOSED`.

Na prática do projeto, o número em `version` (em `logic.ts`) sobe a cada mudança
que altera o mundo gerado (terreno, path, layout de segmentos), e cada subida
recebe uma linha de comentário explicando a mudança. Mudanças só em `interpret`
ou em shaders (visual ao vivo) não alteram o mundo gerado.

---

# 7. Estrutura recomendada da documentação do cenário

Cada cenário deve possuir uma documentação própria.

Estrutura sugerida:

# Scenario: [Scenario Name]

## 1. Metadata
- ID
- Name
- Version
- Status
- Description

## 2. Visual Identity
- Concept
- Art direction
- Color palette
- Geometry
- Materials
- Atmosphere
- Visual references

## 3. World Composition
- Environment
- Spatial organization
- Main elements
- Secondary elements
- Segment composition
- Transitions

## 4. Musical Features
- Selected features
- Reasons for selection
- Expected availability
- Confidence handling

## 5. Visual Capabilities
- Selected visual systems
- Controlled properties
- Static properties
- Dynamic properties

## 6. Musical Interpretation Matrix
- Feature-to-property mappings
- Priorities
- Influence
- Response curves
- Smoothing
- Limits
- Fallbacks
- Conflict resolution

## 7. Temporal Behavior
- Calm sections
- Energy increases
- Rhythmic events
- Transitions
- Pauses
- Climaxes

## 8. Procedural Generation
- Composition rules
- Seed usage
- Segment generation
- Deterministic behavior

## 9. Technical Implementation
- Files
- Interfaces
- Dependencies
- Shared systems
- Scenario-specific systems

## 10. Performance
- Geometry considerations
- Instancing
- Materials
- Shader complexity
- Resource lifecycle

## 11. Testing
- Determinism
- Arbitrary-time reconstruction
- Feature fallbacks
- Rendering
- Performance

## 12. Decisions and Open Questions
- DECIDED
- PROPOSED
- OPEN

---

# 8. Critérios de qualidade

Um cenário só deve ser considerado pronto quando atender aos critérios aplicáveis abaixo.

## Arquitetura

- Não duplica a análise musical.
- Não assume responsabilidades globais.
- Utiliza os contratos compartilhados.
- Mantém sua interpretação musical isolada.
- Não introduz dependências desnecessárias.

## Identidade visual

- Possui uma identidade reconhecível.
- A composição é coerente.
- Os elementos principais e secundários estão definidos.
- A experiência não se reduz a um visualizador de áudio convencional.

## Interpretação musical

- Utiliza features relevantes.
- Possui mapeamentos explícitos.
- Define prioridades.
- Define limites e suavização quando necessários.
- Não depende de features indisponíveis sem fallback.
- Não apresenta conflitos não resolvidos entre regras.

## Determinismo

- Utiliza seeds estáveis.
- Gera segmentos reproduzíveis.
- Não depende do FPS.
- Não depende do histórico de frames.
- Permite reconstrução temporal.

## Desempenho

- Evita alocações desnecessárias.
- Reutiliza recursos quando possível.
- Considera a quantidade de objetos.
- Evita shaders desnecessariamente caros.
- Libera recursos corretamente.

## Assinatura e grupos

- Existe uma assinatura clara, estrutural e determinística.
- O mundo está dividido em grupos visuais, cada um com driver principal explícito.
- Grupos não compartilham o mesmo driver sem justificativa.
- Há elementos independentes da música.
- Há profundidade (fundo, meio, próximo) e continuidade até o horizonte.

## Manutenibilidade

- Possui responsabilidades bem separadas.
- É documentado.
- Pode ser atualizado sem comprometer outros cenários.
- Possui testes adequados.

---

# 9. Regras de comportamento da IA

Durante toda a execução desta skill, a IA deve seguir estas regras:

1. Consultar os documentos oficiais do projeto antes de propor alterações arquiteturais.
2. Distinguir regras fixas de configurações específicas do cenário.
3. Não inventar contratos ou APIs existentes.
4. Verificar o código antes de assumir que um sistema está implementado.
5. Não transformar exemplos desta skill em regras obrigatórias.
6. Não forçar o uso de todas as features musicais.
7. Não forçar o uso de todas as capacidades visuais.
8. Não estabelecer prioridades universais entre features.
9. Não implementar análise musical dentro do cenário.
10. Não comprometer o determinismo por efeitos visuais.
11. Não modificar a câmera ou o fluxo global da experiência.
12. Não alterar a stack tecnológica aprovada sem justificativa.
13. Não modificar outros cenários sem necessidade.
14. Não adicionar sistemas compartilhados apenas por antecipação.
15. Não tratar recomendações arquiteturais como decisões obrigatórias.
16. Documentar decisões relevantes.
17. Identificar claramente o que é decisão, proposta ou questão em aberto.
18. Perguntar ao usuário somente quando uma informação ausente for realmente necessária.
19. Quando houver liberdade de escolha, propor a solução mais coerente com a identidade do cenário.
20. Explicar decisões técnicas que afetem determinismo, desempenho ou arquitetura.

---

# 10. Formato de entrega

Ao concluir uma criação ou atualização, apresentar um resumo com:

## Resultado
- O que foi criado ou atualizado.

## Identidade visual
- Características principais do cenário.

## Interpretação musical
- Features utilizadas.
- Propriedades visuais controladas.
- Principais mapeamentos e prioridades.

## Arquitetura
- Sistemas compartilhados reutilizados.
- Sistemas específicos implementados.
- Arquivos criados ou modificados.

## Validação
- Testes executados.
- Resultado do build.
- Limitações ou verificações pendentes.

## Decisões pendentes
- Questões `OPEN`.
- Propostas que precisam de aprovação.

Não declarar uma implementação concluída quando houver etapas essenciais não executadas.

A entrega deve ser objetiva, mas suficientemente detalhada para permitir revisão técnica.

---

# 11. Princípio fundamental

O Sonora fornece:

1. Um vocabulário musical compartilhado.
2. Um conjunto extensível de capacidades visuais.
3. Uma infraestrutura comum de geração procedural, sincronização e renderização.

Cada cenário define:

1. Sua própria identidade visual.
2. Quais informações musicais são relevantes.
3. Quais propriedades visuais serão utilizadas.
4. Como as informações musicais influenciam essas propriedades.
5. Quais prioridades e comportamentos tornam sua experiência única.

A IA deve preservar essa separação em todas as decisões de design e implementação.

**O objetivo não é fazer todos os cenários reagirem à música da mesma forma. O objetivo é permitir que todos utilizem a mesma infraestrutura para criar experiências visuais diferentes.**

---

# 12. Cenário de referência: Synthwave Dimension

Antes de criar ou atualizar um cenário, **ler** `src/scenarios/synthwave/logic.ts`,
`path.ts` e `scene.ts`. Eles definem o nível de estrutura e acabamento esperado.
O que vale reproduzir é o **método**, não o conteúdo (seção 3.4): estrada,
montanhas, cidade e sol são escolhas do Synthwave.

## 12.1 Assinatura do Synthwave

A estrada sobe, desce e muda de velocidade, seguindo a intensidade da música
(`createTrackPath`): intensidade = loudness + flux, suavizada; inclinação vem da
intensidade absoluta e do contraste com os ~20 s ao redor; velocidade segue a
intensidade e a inclinação; a altura é a integral da inclinação; finais calmos
achatam a estrada. Tudo é função pura da timeline, avaliada por tempo da faixa.

## 12.2 Grupos do Synthwave (exemplo de tabela da etapa 2.1)

| Grupo | Driver principal | Baked / ao vivo |
|---|---|---|
| Estrada | intensidade (loudness + flux) | baked (path) |
| Montanhas | energia (altura via `amplitudeAt`) + `bass` (pulso) | baked + ao vivo |
| Chão e grade | `bass` + `energy` (brilho) | ao vivo |
| Céu e sol | `bass` (tamanho), `energy` (brilho), `flux` (flash) | ao vivo |
| Estrelas | `bass`, `mid`, `high` (três populações) | ao vivo |
| Brasas | `energy` (densidade), `mid` + `flux` (brilho) | ao vivo |
| Cidade (anel de horizonte) | `bass` + `energy` (brilho), `energy` (janelas), `high` + `flux` (faróis) | ao vivo |

## 12.3 O que tornou o Synthwave completo (usar como checklist de acabamento)

Adaptar cada item à identidade do novo cenário; um item só é dispensado quando
não faz sentido para ele, e a dispensa deve ser explicada na entrega.

- Camadas de distância: segmentos detalhados perto e **campo distante** (LOD,
  `farField`) com transição por dither sem emenda; `viewDistance` cobre o campo
  distante.
- **Anel de horizonte** ancorado na altura do chão à frente (não flutua), com
  planície, silhueta distante e fundo.
- **Crescimento por proximidade**: elementos nascem pequenos ao longe e chegam ao
  tamanho final perto da câmera (função pura da distância).
- **Neblina na cor do céu** (mesma função de cor), sem borda visível no fim do
  mundo carregado.
- **Vida ambiental independente da música**, time-addressable (janelas em relógio
  próprio, brasas com queda e balanço por tempo da faixa); a música só modula.
- **Variação por mundo** via `worldSalt`/seeds derivadas, sem `Math.random`.
- Geometria reutilizada: instancing e atributos de índice compartilhados;
  `dispose` libera geometrias e materiais.
- `Params` agrupados por grupo e comentados; `interpret` na mesma ordem.
- Final da faixa tratado (calma/epílogo) quando a assinatura depende do tempo.
- Histórico de versões comentado em `version`.

## 12.4 Limites desta referência

- Nenhum mapeamento do Synthwave (por exemplo `bass` → sol) é obrigatório em
  outro cenário.
- Se o Synthwave for modificado, esta seção deve ser atualizada para continuar
  descrevendo o código real. Não alterar o Synthwave ao criar outro cenário.

---

# 13. Bugs conhecidos e lições aprendidas

Registro de bugs reais encontrados nos cenários: sintoma, causa e correção. Antes
de criar ou atualizar um cenário, verificar se ele repete algum destes padrões.
Ao corrigir um novo bug que possa se repetir em outro cenário, registrá-lo aqui
no mesmo formato.

## 13.1 Flags inteiros em varying interpolado (Voxel Dreamscape)

**Sintoma.** Glowstone, véu do portal e obsidiana chorona piscavam várias vezes
por segundo entre aceso e escuro (e às vezes com um tom verde), em manchas que
mudavam conforme a câmera andava. Magma, lava e água tinham o mesmo risco.
Blocos com flags `0` (obsidiana comum, pedra) não eram afetados.

**Causa.** O mesher empacota face, AO, luz e **flags de material** num único
float por vértice (`packed`, `mesher.ts`). O vertex shader extrai os flags e os
envia ao fragment shader num `varying` comum (`vInfo.w`). Mesmo com o mesmo
valor nos quatro vértices, a interpolação com correção de perspectiva em float32
não é exata: `8.0` chega como `7.9999995` em alguns pixels. O fragment shader
decodificava com `floor(flags / bit)` sem margem, então:

- `floor(7.9999995 / 8) = 0`: perdia o bit `emissive` (o bloco escurecia);
- `mod(7.9999995, 4) ≈ 3.99`: virava tint 3 (birch, verde).

Só os valores que caem exatamente na fronteira de um bit testado são afetados
(glowstone `8`, portal `56`, chorona `32`, magma/lava `24`, água `16`); zero é
interpolado sem erro. O piscar no tempo vem de o erro depender da posição de
cada pixel no triângulo, que muda a cada frame com a câmera.

**Correção.** Arredondar antes de decodificar: `floor(v + 0.5)`
(`materialFlags` em `FLAGS_GLSL`, `blocks.ts`), usado em todo ponto do shader
que lê `vInfo.w`. Alternativa mais estrita: varying `flat` (WebGL2), que exige
separar os campos discretos dos interpolados (AO e luz precisam continuar
interpolados). Testes em `tests/voxel.test.ts`: simulação da interpolação em
float32 para todos os blocos, que confirma que o `floor` direto falha e que
`materialFlags` recupera todos os bits e o tint; e verificação dos flags
emissivos no mesh de glowstone e portal.

**Regra para qualquer cenário.**

- Nunca aplicar `floor`, `mod` ou comparação exata a um `varying` interpolado
  que representa um valor discreto (id, flag, layer, face). Arredondar com
  `floor(v + 0.5)` ou usar `flat`.
- Testes de limiar sobre valores interpolados devem ter folga de pelo menos 0.5
  (por exemplo `tint > 2.5`), nunca cair exatamente num inteiro.
- Manter a decodificação dos bits em um único lugar compartilhado entre o GLSL e
  uma versão TypeScript equivalente, para que os testes cubram a mesma regra que
  o shader.
- Sintoma típico: piscar ou "ruído" que só aparece em alguns materiais e muda com
  o movimento da câmera, sem relação com a música.

## 13.2 Feature crua em superfície grande e padrão procedural subpixel (Voxel Dreamscape)

**Sintoma.** A camada de nuvens piscava no céu. As nuvens são um plano único
(2400 m) com células de 12 m recortadas por ruído no fragment shader.

**Causas (duas, somadas).**

1. **Driver sem suavização.** `cloudGlow = 0.3 + 0.7 * mid` ia direto ao
   uniform. A feature `mid` é amostrada a 100 Hz sem suavização, então o brilho
   da nuvem mudava a cada frame. Medido com uma faixa real a 60 fps: variação
   média de 1,1% por frame, e 87% das janelas de 0,25 s com oscilação acima de
   4%. Numa área clara e grande como as nuvens, isso aparece como cintilação.
2. **Serrilhado do padrão procedural.** As bordas das células vêm do `discard`
   por ruído, não de arestas de triângulo, então o MSAA não as suaviza. Ao longe
   e em ângulo rasante, uma célula ocupa poucos pixels e o padrão "ferve" quando
   a câmera se move.

**Correção.**

1. Suavizar o driver no `scene.ts` com média exponencial pelo tempo da faixa
   (`CLOUD_SMOOTH_S = 0.6`, o mesmo padrão já usado para `energy`, com
   `ENERGY_SMOOTH_S = 0.25`). Com 0,6 s, nenhuma janela de 0,25 s passa de 4%.
2. Medir `fwidth` das coordenadas de célula (antes de qualquer `discard`, para
   as derivadas serem válidas) e esmaecer as nuvens quando a célula fica menor
   que alguns pixels.

**Regra para qualquer cenário.**

- Features cruas (`energy`, `bass`, `mid`, `high`, `flux`) variam a cada frame.
  Elas só podem ir direto a um uniform quando o efeito é pequeno ou
  intencionalmente percussivo (faíscas, flashes de onset). Brilho de superfícies
  grandes deve ser suavizado (cerca de 0,25 a 1 s).
- Padrões procedurais com bordas duras no fragment shader (`floor`/`step` +
  `discard`) precisam de anti-aliasing próprio: esmaecer ou filtrar por
  `fwidth` quando o detalhe fica subpixel.
- Ao diagnosticar um piscar, separar as causas: com a música pausada e a câmera
  andando, o que pisca é serrilhado; com a câmera parada e a música tocando, é o
  driver.
