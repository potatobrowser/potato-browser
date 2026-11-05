import type { ShieldRule } from './types';
import { ruleMatchesHost } from './match';

/*
 * The catalog of known AI features per site (November 2026).
 *
 * Selectors prefer stable hooks (ids, data-attributes, custom elements, hrefs, aria-labels, icon
 * paths) over generated class names. Many were informed by community filter lists, notably
 * Stevo's AI Blocklist (MIT, see THIRD_PARTY_NOTICES.md), the EasyList "AI widgets" list and
 * AdGuard's annoyance filters. Visible strings carry common translations (en, de, fr, es, it,
 * pt, nl, pl, hu, ja).
 */

const AI_OVERVIEW = [
  'AI Overview',
  'AI Overviews',
  'Übersicht mit KI',
  'Aperçu IA',
  'Aperçu généré par IA',
  'Vista creada con IA',
  'Visão geral criada por IA',
  'AI-overzicht',
  'Przegląd od AI',
  'AI-alapú áttekintés',
  'AI által készített áttekintés',
  'AI による概要',
];
const AI_MODE = ['AI Mode', 'KI-Modus', 'Mode IA', 'Modo IA', 'AI-modus', 'Tryb AI', 'AI-mód', 'AI モード'];
const HELP_ME_WRITE = [
  'Help me write',
  'Formuliere für mich',
  'Aide-moi à écrire',
  'Ayúdame a escribir',
  'Aiutami a scrivere',
  'Me ajude a escrever',
  '文書作成サポート',
];
const ASK_GEMINI = [
  'Ask Gemini',
  'Try Gemini',
  'Gemini',
  'Show Gemini',
  'Open Gemini',
  'Frag Gemini',
  'Demander à Gemini',
  'Pregunta a Gemini',
  'Chiedi a Gemini',
  'Peça ao Gemini',
  'Vraag het Gemini',
  'Zapytaj Gemini',
  'Kérdezés a Geminitől',
  'Gemini に相談',
];
const GROK_ACTIONS = [
  'Grok actions',
  'Grok-Aktionen',
  'Actions Grok',
  'Acciones de Grok',
  'Azioni di Grok',
  'Ações do Grok',
  'Grok-acties',
  'Akcje Groka',
  'Grok-műveletek',
  'Grokのアクション',
];
const PROFILE_SUMMARY = [
  'Profile Summary',
  'Kurzprofil',
  'Résumé du profil',
  'Resumen del perfil',
  'Riepilogo del profilo',
  'Resumo do perfil',
  'Profieloverzicht',
  'Podsumowanie profilu',
  'Profil összegzése',
  'プロフィールの要約',
];

/** Gemini "spark" icon used across Google Workspace; matched by its path data prefix. */
const WORKSPACE_SPARK = 'path[d^="M480-80q-6,0-11-4t-7-10q-17-67-51-126"]';
const YOUTUBE_SPARK = 'path[d^="M480-80q0-83-31.5-156T363-363q-54-54-127-85.5T80-480"]';
const YOUTUBE_SPARK_MOBILE = 'path[d^="M1 12c6.075 0 11 4.925 11 11 0-6.075"]';
const GROK_LOGO = 'path[d^="M12.745 20.54l10.97-8.19"]';
const BUTTONISH = 'button, [role="button"], [role="menuitem"], [role="tab"], [role="link"], a';

export const RULES: ShieldRule[] = [
  // ---- Google -------------------------------------------------------------------------------------
  {
    id: 'google-search',
    site: 'Google Search',
    hosts: ['google.*'],
    paths: ['^/$', '^/search', '^/webhp'],
    features: [
      {
        id: 'ai-overview',
        name: 'AI Overviews',
        css: [
          '[data-attnms]',
          '#Odp5De:has([data-attnms])',
          '.Kevs9.SLPe5b:has([data-attnms])',
          '.ULSxyf:has(> .MjjYud > .Wm5I1e.SePcAf[data-tma="80"] [data-attnms])',
          'div[style^="margin-bottom:"][data-hveid]:has(div[id^="folsrch"])',
          '[data-attrid="VisualDigestGeneratedDescription"]',
          '[jscontroller="Elkdbc"]',
        ],
        match: [
          {
            candidates: 'h1, h2, h3, [role="heading"]',
            texts: AI_OVERVIEW,
            maxLength: 60,
            notInside: 'a',
            hide: {
              closest: '#rso [data-rpos]',
              upTo: '#rso',
              climbFree: '#rso, #center_col, #search, #rhs, form, [name="q"], [role="search"], a h3',
              stopAt: '#rcnt, #center_col, #rso, #search, main, #cnt, #rhs, body',
            },
          },
        ],
        block: ['/async/folsrch'],
      },
      {
        id: 'paa-ai',
        name: 'AI answers in "People also ask"',
        css: [
          '[jsname="YrZdPb"][data-evn]',
          '.cUnQKe:has([jsname="YrZdPb"][data-evn]):not(:has([jsname="YrZdPb"]:not([data-evn])))',
        ],
      },
      {
        id: 'ai-mode',
        name: 'AI Mode',
        css: [
          '[role="listitem"]:has(a[href*="udm=50"])',
          'a[href*="udm=50"]:not(:has(#hplogo)):not(#mlogo):not(:has(img))',
          'li[data-attrid$="Prediction"]:has([aria-description="AI Mode"])',
          '[role="button"][data-azi][jsname="pLYtdd"]',
          '[jscontroller="DyTeib"]',
          '.plR5qb',
        ],
        match: [
          { candidates: 'button, [role="button"], [role="link"], a', texts: AI_MODE, maxLength: 20, hide: { closest: '[role="listitem"]' } },
          { candidates: 'button, [role="button"], [role="link"], a', patterns: ['^ask anything in ai mode$', '^dive deeper in ai mode$'], maxLength: 40 },
        ],
      },
      {
        id: 'ai-shopping',
        name: 'AI shopping tools',
        css: [
          '[jsname="lHCI7d"]',
          '[jsname="NoEzVd"]:has([jsname="lHCI7d"])',
          '[data-id="SALES_ASSISTANT_BRAND_PROFILE_ENTRY_POINT"]',
          '[data-id="PRODUCT_SHELF_SALES_ASSISTANT_ENTRY_CONTAINER"]',
          'a[href^="/shopping/tryon"]',
        ],
      },
      {
        id: 'ai-links',
        name: 'Gemini and AI promos',
        css: ['[role="contentinfo"] a[href^="https://ai.google/"]', 'a[href^="https://ai.google/helpful-tools/"]', 'a[href^="https://labs.google.com/search"]'],
      },
    ],
  },
  {
    id: 'google-apps-menu',
    site: 'Google apps menu',
    hosts: ['ogs.google.*'],
    features: [{ id: 'gemini-apps', name: 'Gemini and NotebookLM tiles', css: ['.j1ei8c:has(> [data-pid="658"], > [data-pid="666"])'] }],
  },
  {
    id: 'google-maps',
    site: 'Google Maps',
    hosts: ['google.*', 'maps.google.*'],
    paths: ['^/maps'],
    features: [
      {
        id: 'ask-maps',
        name: 'Ask Maps (Gemini)',
        css: [
          '[jsaction="navigationrail.askMaps"]',
          '.AJqepd:has([jsaction="settings.askGemini"])',
          '[role="dialog"][aria-label="Ask anything about anywhere"]',
        ],
      },
    ],
  },
  {
    id: 'gmail',
    site: 'Gmail',
    hosts: ['mail.google.com'],
    features: [
      {
        id: 'gemini',
        name: 'Gemini button and panel',
        css: [
          '[data-rp-placement-id="gemkick-pep-icon-callout-id"]',
          '[data-pep-id="global-pep-gmail"]',
          '.e5IPTd',
          '.lRwCV',
          `[role="button"]:has(${WORKSPACE_SPARK})`,
          `button:has(${WORKSPACE_SPARK})`,
        ],
        match: [
          {
            candidates: 'button[aria-label], [role="button"][aria-label], [data-tooltip]',
            attr: 'aria-label',
            texts: ASK_GEMINI,
            hide: { closest: '.e5IPTd' },
          },
          { candidates: '[data-tooltip]', attr: 'data-tooltip', texts: ASK_GEMINI },
        ],
      },
      {
        id: 'help-me-write',
        name: 'Help me write',
        css: ['[data-tooltip*="Help me write"]', '.bDl[command="sdt"]', '.eLNZDd[command="sdt"]', '.jKzJCd'],
        match: [
          { candidates: 'button[aria-label], [role="button"][aria-label], [role="menuitem"][aria-label]', attr: 'aria-label', texts: HELP_ME_WRITE },
          { candidates: '[data-tooltip]', attr: 'data-tooltip', texts: HELP_ME_WRITE },
        ],
      },
      {
        id: 'summaries',
        name: 'Email summaries',
        css: ['.eJPjde', '.JLWipf'],
        match: [{ candidates: 'button, [role="button"]', texts: ['Summarize this email', 'Summarise this email'], maxLength: 40 }],
      },
      { id: 'smart-reply', name: 'Suggested replies', css: ['.mVCoBd'] },
      {
        id: 'promos',
        name: 'Gemini promos',
        css: [
          '.einvLd',
          'div[data-container-id$=":growth_promo_banner:growth_promo_banner"]:has(span[data-action-behavior*="https://one.google.com/ai"])',
        ],
        placeholders: [{ selector: 'input[aria-label], input[placeholder]', patterns: ['^ask gmail'], replacement: 'Search mail' }],
      },
    ],
  },
  {
    id: 'google-workspace',
    site: 'Google Docs, Sheets, Slides, Drive',
    hosts: ['docs.google.com', 'drive.google.com', 'chat.google.com', 'calendar.google.com', 'meet.google.com', 'classroom.google.com', 'keep.google.com', 'vids.google.com'],
    features: [
      {
        id: 'gemini-panel',
        name: 'Gemini side panel and buttons',
        css: [
          '#docs-sidekick-gen-ai-promo-button-container',
          '#docs-sidekick-button-container',
          '.appsElementsSidekickAuroraEntryPointRoot',
          '.appsElementsSidekickBarkickMinimizedButton',
          '.kixWizBarkickWrapper',
          '#WWNEkf',
          '#bPjCde',
          '#askGemini',
          '.rHn5Xc.e5IPTd',
          '[data-rp-placement-id="gemkick-pep-icon-callout-id"]',
          `[role="button"]:has(${WORKSPACE_SPARK})`,
          `button:has(${WORKSPACE_SPARK})`,
          `[role="menuitem"]:has(${WORKSPACE_SPARK})`,
          '[role="menuitem"][href="/ai"]',
        ],
        match: [{ candidates: 'button[aria-label], [role="button"][aria-label]', attr: 'aria-label', texts: ASK_GEMINI }],
        placeholders: [{ selector: 'input[placeholder], input[aria-label]', patterns: ['^get answers from drive'], replacement: 'Search in Drive' }],
      },
      {
        id: 'help-me-create',
        name: 'Help me write, create and visualize',
        css: [
          '.superfab-aitextgeneratormenu-button',
          '.inlineFabBubbleContainerRefineButtonContainer',
          '.apps-menuitem:has(.goog-menuitem-label[aria-label="Gemini 2"])',
          '#openSidekickForSlideGenerationButton',
          '#content-library-rail-slide-generation-element',
          '.appsSketchyPluginsFloatingToolbarFloatingToolbarComponentGenerativeAiButton',
          '.goog-menuitem:has([aria-label^="Help me visualize"])',
          '.goog-menuitem:has([aria-label^="Beautify this slide"])',
          '[data-action-id="freebird-open-help-me-ask-from-icon"]',
          '#content-library-rail-image-synthesis-element',
          '#content-library-rail-avatars-element',
          '#content-library-rail-voiceovers-element',
          '#content-library-rail-video-generation-element',
          '#video-generation-promo',
        ],
        match: [{ candidates: 'button[aria-label], [role="button"][aria-label], [role="menuitem"]', attr: 'aria-label', texts: HELP_ME_WRITE }],
      },
      {
        id: 'sheets-gemini',
        name: 'Gemini in Sheets',
        css: [
          '#docs-gemini-menu',
          '.FormulaBarContainerGeminiSummarizeButton',
          '.geminiFixButtonWrapper',
          '.waffle-unified-formula-help-gemini-button-only',
          '.waffleGriddySuggestionsBubbleGeminiUi',
          '.building-blocks-sidekick-entrypoint-button',
        ],
      },
      {
        id: 'drive-ai',
        name: 'Drive AI summaries',
        css: [
          '[data-test-id="help-me-organize-chip-container"]',
          '.oaTPh',
          '.De8rPe',
          'button[aria-label="Create an audio overview"]',
          '[role="dialog"][data-promotype="19"]',
        ],
      },
    ],
  },
  // ---- YouTube ------------------------------------------------------------------------------------
  {
    id: 'youtube',
    site: 'YouTube',
    hosts: ['youtube.com', 'm.youtube.com', 'studio.youtube.com', 'music.youtube.com'],
    features: [
      {
        id: 'ask',
        name: 'Ask (AI chat about videos)',
        css: [
          '.you-chat-entrypoint-button',
          'yt-button-view-model:has(> .you-chat-entrypoint-button)',
          `yt-button-view-model:has(${YOUTUBE_SPARK})`,
          `button-view-model:has(${YOUTUBE_SPARK_MOBILE})`,
          '.ytp-suggested-action-badge[aria-label="Ask about this video"]',
          'yt-video-description-youchat-section-view-model',
        ],
      },
      {
        id: 'summary',
        name: 'AI video summaries',
        css: [
          '#video-summary',
          'ytd-expandable-metadata-renderer[has-video-summary]',
          `#expandable-metadata:has(${YOUTUBE_SPARK})`,
          'ytm-expandable-metadata-renderer:has(.expandableMetadataRendererCollapsedLeftSectionSummary)',
          'yt-live-chat-banner-manager:has(yt-live-chat-banner-chat-summary-renderer)',
        ],
      },
      {
        id: 'ask-youtube',
        name: 'Ask YouTube (AI search)',
        css: [
          '[aria-label="Ask YouTube"]',
          'yt-searchbox [client-ve-type="307188"]',
          '.ytSearchboxComponentAiSuggestionsContainer',
          '[chip-style="STYLE_AI_MODE_CHIP"]',
          'ytd-talk-to-recs-flow-renderer',
        ],
        placeholders: [{ selector: 'input[placeholder]', patterns: ['^search or ask'], replacement: 'Search' }],
      },
      {
        id: 'studio',
        name: 'YouTube Studio AI tools',
        css: [
          'ytcp-creator-chat-trigger',
          'ytcp-creator-chat-entrypoint-button',
          '#inspiration-tab',
          '#comment-smart-replies',
          '[test-id="VIDEO_BRAINSTORM_IDEA"]',
          '.ask-studio-container',
        ],
      },
    ],
  },
  // ---- Microsoft ----------------------------------------------------------------------------------
  {
    id: 'bing',
    site: 'Bing',
    hosts: ['bing.com', 'cn.bing.com'],
    features: [
      {
        id: 'copilot-answers',
        name: 'Copilot answers',
        css: [
          '.b_ans:has(> #copans_container)',
          '#copans_container',
          '.b_ans.b_top:has(> .cht_container)',
          '.b_ans:has(> #b_wpt_container_ml)',
          '#b_copilot_search_container',
          '#b_copilot_search',
        ],
        block: ['/qna/fetchCodexQnA'],
      },
      {
        id: 'copilot-entry',
        name: 'Copilot buttons and tabs',
        css: [
          '#b-scopeListItem-conv',
          '#b-scopeListItem-copilotsearch',
          '#codex',
          'a[href^="/chat?"]',
          'a[href^="/copilotsearch?"]',
          'a[href*="copilot.microsoft.com"]',
          '.cdxCopilotIconBg',
          '#m365copilot_overflow',
          '#aitools',
          '#sa_ai_block',
          '#chat_upsell_bubble_icon',
          '#ccpg-container:has(#b_cp_upsell_box_parent)',
          'li:has(> a[href^="/images/create"])',
        ],
      },
    ],
  },
  {
    id: 'msn',
    site: 'MSN',
    hosts: ['msn.com'],
    features: [{ id: 'copilot', name: 'Copilot button', css: ['fluent-button#codex-bing-button', 'codex-bing-chat'] }],
  },
  {
    id: 'microsoft-365',
    site: 'Outlook and Microsoft 365',
    hosts: [
      'outlook.office.com',
      'outlook.office365.com',
      'outlook.live.com',
      'outlook.cloud.microsoft',
      '*.cloud.microsoft',
      '*.officeapps.live.com',
      'teams.microsoft.com',
      'teams.live.com',
      'office.com',
      'microsoft365.com',
    ],
    features: [
      {
        id: 'copilot',
        name: 'Copilot',
        css: [
          '[data-app-section="CopilotDabRibbon"]',
          '#CopilotCommandCenterButton',
          '#BottomBar > div:has(> div > #copilot-dab-main-button)',
          '.fai-CopilotProvider',
          '#CopilotDABContainer',
          '#CopilotChat-group',
          '#Copilot-group',
          '#ChatPPT-group',
          '[aria-label="Explore Copilot section."]',
          '[aria-label="Create with Copilot"]',
          '[data-testid="list-item-metaos-copilot"]',
        ],
        match: [
          {
            candidates: 'button[aria-label], [role="button"][aria-label], [role="menuitem"][aria-label], [role="tab"][aria-label]',
            attr: 'aria-label',
            texts: ['Copilot', 'Microsoft Copilot', 'Open Copilot', 'Copilot chat', 'Summarize', 'Summarise', 'Draft with Copilot'],
          },
        ],
      },
    ],
  },
  // ---- Other search engines ----------------------------------------------------------------------
  {
    id: 'duckduckgo',
    site: 'DuckDuckGo',
    hosts: ['duckduckgo.com', 'noai.duckduckgo.com', 'html.duckduckgo.com'],
    features: [
      {
        id: 'search-assist',
        name: 'Search Assist',
        css: ['[data-react-module-id="wikinlp"]', '[data-layout="wikinlp"]', 'li:has([data-testid="duckassist-answer-content"])'],
      },
      {
        id: 'duck-ai',
        name: 'Duck.ai chat',
        css: [
          '[data-testid="aichat-button"]',
          'button[title="Ask Duck.ai"]',
          '[data-ssg-id="ask-duck-ai-submit"]',
          '[data-ssg-id="ai-searchbox-chat-submit"]',
          'a[href*="ia=chat"]',
          'a[href^="https://duck.ai"]',
          'a[href*="&assist="]',
          '[class*="header_aiChatButton__"]',
          '[class*="ai-searchbox_modeSelectorWrapper__"]',
          '[class*="search-input_duckAiSubmitWrapper__"]',
          '[class*="chip-select_option__"]:has(> span[title="Duck.ai"])',
        ],
      },
    ],
  },
  {
    id: 'brave-search',
    site: 'Brave Search',
    hosts: ['search.brave.com'],
    features: [
      {
        id: 'ai-answers',
        name: 'AI answers and Ask',
        css: ['#llm-snippet', '#submit-llm-button', '.tab-item:has(> a[href^="/ask"])', 'a[href^="/ask?q="]', 'div.ai-digest'],
        block: ['/api/chatllm/'],
      },
    ],
  },
  {
    id: 'ecosia',
    site: 'Ecosia',
    hosts: ['ecosia.org'],
    features: [
      {
        id: 'ai',
        name: 'AI search and chat',
        css: [
          '.omnibox-search-form__ai-chat',
          '.omnibox-search-form__ai-search',
          '.ai-search-button',
          '[data-test-id="search-navigation-item-chat"]',
          '[data-test-id="search-form-ai-suggestion"]',
          'a[href^="/ai-chat"]',
        ],
      },
    ],
  },
  {
    id: 'yahoo',
    site: 'Yahoo',
    hosts: ['yahoo.com', '*.yahoo.com', 'yahoo.co.jp', '*.yahoo.co.jp'],
    features: [
      {
        id: 'scout',
        name: 'Yahoo Scout (AI answers)',
        css: [
          '[aria-label="Search with Yahoo Scout"]',
          '[role="menuitem"]:has(> [href^="https://scout.yahoo.com/"])',
          '.sb-scout-wrap',
          '.scoutNav',
          '.scout-tab',
          '.scoutPromo',
          '.scoutPromoPopup',
          '.summary-container:has(> .ai-summary)',
          '[aria-label="Summarize with Yahoo Scout"]',
          '[data-test-id="tldr-inbox-list-opt-in-card"]',
          '#aichat',
          '.AiAssistant',
        ],
      },
    ],
  },
  {
    id: 'kagi',
    site: 'Kagi',
    hosts: ['kagi.com'],
    features: [
      {
        id: 'assistant',
        name: 'Quick Answer and Assistant',
        css: [
          'button.quick-answer-trigger-link',
          '._0_quick_answer_box',
          '.summarize-link',
          '._0_result_page_summary',
          '._0_summarize_page',
          '._0_discuss_document',
          'a[href="/assistant"]',
          'a[href="/summarizer"]',
          'a[href="/fastgpt"]',
        ],
      },
    ],
  },
  // ---- Social -------------------------------------------------------------------------------------
  {
    id: 'x',
    site: 'X (Twitter)',
    hosts: ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'],
    features: [
      {
        id: 'grok-nav',
        name: 'Grok in navigation',
        css: ['nav a[href$="/i/grok"]', '[role="menu"] a[href="/i/grok"]', 'a[href="https://grok.com/"]', 'button[aria-label="Grok"]'],
      },
      { id: 'grok-drawer', name: 'Grok chat drawer', css: ['div[data-testid="GrokDrawer"]'] },
      {
        id: 'grok-posts',
        name: 'Grok buttons on posts',
        css: [
          '[data-testid="tweet"] button[aria-label*="Grok"]',
          '[data-testid="tweet"] [data-testid^="followups_"]',
          '[data-testid="tweet"] a[href="/i/grok"]',
          '[data-testid="grok_post_atgrok_button"]',
          `button:has(${GROK_LOGO})`,
          `a:has(${GROK_LOGO})`,
        ],
        match: [{ candidates: 'button[aria-label]', attr: 'aria-label', texts: GROK_ACTIONS }],
      },
      {
        id: 'grok-tools',
        name: 'Grok Imagine, compose and summaries',
        css: [
          'button[data-testid="grokImgGen"]',
          'a[href^="/i/imagine"]',
          'a[href^="https://grok.com/imagine"]',
          'a[href^="/i/grok-redirect"]',
          '[data-testid="primaryColumn"] > div > div:has(> [data-testid="followups_search"])',
          '[data-testid="cellInnerDiv"]:has([data-testid="inlinePrompt-primaryAction"] > [href^="https://grok.com/"])',
          'aside:has(a[href^="https://grok.com/"])',
        ],
        match: [{ candidates: 'button[aria-label]', attr: 'aria-label', texts: PROFILE_SUMMARY }],
      },
    ],
  },
  {
    id: 'facebook',
    site: 'Facebook',
    hosts: ['facebook.com', 'web.facebook.com', 'm.facebook.com'],
    features: [
      {
        id: 'meta-ai',
        name: 'Meta AI',
        css: [
          '[role="listitem"]:has(a[href*="www.meta.ai"])',
          'li:has(a[href*="www.meta.ai"])',
          'a[href*="www.meta.ai"]',
          'a[href^="https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.meta.ai"]',
          'a[href^="https://aistudio.facebook.com/"]',
          '[role="listitem"]:has(a[href="/messages/t/156025504001094/"])',
          'a[href="/messages/t/156025504001094/"]',
          '[aria-label="Generate images using AI"]',
          '[aria-label="Chat with Meta AI support assistant"]',
          '[role="button"][aria-label="Meta AI"]',
          '[aria-label="Meta AI icon"]',
        ],
        placeholders: [
          { selector: 'input[placeholder], input[aria-label]', patterns: ['meta ai'], replacement: 'Search Facebook' },
        ],
      },
      {
        id: 'comment-summary',
        name: 'AI comment summaries',
        match: [{ candidates: 'img[alt="Meta AI logo"]', any: true, hide: { levels: 3 } }],
      },
    ],
  },
  {
    id: 'messenger',
    site: 'Messenger',
    hosts: ['messenger.com'],
    features: [
      {
        id: 'meta-ai',
        name: 'Meta AI chat',
        css: ['[role="row"]:has(a[href="/t/156025504001094/"])', 'a[href="/t/156025504001094/"]', 'a[href*="www.meta.ai"]'],
        placeholders: [{ selector: 'input[placeholder]', patterns: ['meta ai'], replacement: 'Search Messenger' }],
      },
    ],
  },
  {
    id: 'instagram',
    site: 'Instagram',
    hosts: ['instagram.com'],
    features: [
      {
        id: 'meta-ai',
        name: 'Meta AI',
        css: ['a[href^="https://www.meta.ai"]', 'a[href*="//www.meta.ai"]', '[aria-label="Meta AI icon"]'],
        match: [{ candidates: 'a[role="link"] span, div[role="button"] span, a span', texts: ['Meta AI'], hide: { closest: 'a, [role="button"]' } }],
        placeholders: [{ selector: 'input[placeholder], input[aria-label]', patterns: ['meta ai'], replacement: 'Search' }],
      },
    ],
  },
  {
    id: 'whatsapp',
    site: 'WhatsApp Web',
    hosts: ['web.whatsapp.com'],
    features: [
      {
        id: 'meta-ai',
        name: 'Meta AI',
        css: ['button[aria-label="Meta AI"]', 'div:has(> button[aria-label="Meta AI"])', 'div:has(> button[aria-label="Meta AI"]) + hr'],
        match: [{ candidates: 'span[title="Meta AI"]', texts: ['Meta AI'], hide: { closest: '[role="listitem"], [role="row"]' } }],
        placeholders: [
          { selector: 'input[placeholder], div[contenteditable][aria-label], input[aria-label]', patterns: ['meta ai'], replacement: 'Search' },
        ],
      },
    ],
  },
  {
    id: 'threads',
    site: 'Threads',
    hosts: ['threads.com', 'threads.net'],
    features: [{ id: 'meta-ai', name: 'Meta AI', css: ['a[href*="www.meta.ai"]'] }],
  },
  {
    id: 'linkedin',
    site: 'LinkedIn',
    hosts: ['linkedin.com', '*.linkedin.com'],
    features: [
      {
        id: 'ai-writing',
        name: 'AI writing assistants',
        css: [
          '.share-creation-state__writing-assistant-container--premium',
          'div.pvs-entity__secondary-action-container:has(svg[data-test-icon="premium-signal-ai-small"])',
          'button:has(svg[data-test-icon*="signal-ai"])',
          'a:has(svg[data-test-icon*="signal-ai"])',
        ],
        match: [
          {
            candidates: 'button, [role="button"]',
            texts: ['Rewrite with AI', 'Write with AI', 'Enhance with AI', 'Draft with AI', 'Get AI suggestions'],
            patterns: ['^(rewrite|write|draft|enhance|improve|polish) with ai$'],
            maxLength: 40,
          },
        ],
      },
      {
        id: 'ai-jobs',
        name: 'AI job match and coach',
        css: ['.job-details-module:has(.guide-entry-point-container)', 'div:has(> div > div[data-display-contents="true"] > div[componentkey] > div > #InitialStateHowYouFitSlot)'],
      },
    ],
  },
  {
    id: 'reddit',
    site: 'Reddit',
    hosts: ['reddit.com', '*.reddit.com'],
    features: [
      {
        id: 'answers',
        name: 'Reddit Answers',
        css: [
          '#answers-nav-button',
          '#search-results-page-tab-ai_search',
          'search-telemetry-tracker[view-events="search/view/unit"]:has(search-answers-expandable, search-answers-response-container-streaming, .search-answers-preview-section)',
          '[id^="answers-suggested-queries"]',
          '.expanded-composer-ask-pill',
          'a[href^="/answers/"]:has([icon-name="search-sparkle"])',
          '[slot="comment"] p > a.border-dotted [icon-name="search-sparkle"]',
          'guides-search-input-base',
        ],
        block: ['answers.reddit.com/v1/answers/'],
      },
      {
        id: 'comment-summary',
        name: 'AI comment summaries',
        css: ['.grid:has(> .col-start-2 > conversation-snapshot-text-clamp)', 'conversation-snapshot-text-clamp'],
      },
    ],
  },
  // ---- Shopping and other sites -------------------------------------------------------------------
  {
    id: 'amazon',
    site: 'Amazon',
    hosts: ['amazon.*', 'smile.amazon.*'],
    features: [
      {
        id: 'rufus',
        name: 'Rufus / Alexa shopping assistant',
        css: [
          '#nav-rufus-disco',
          '.nav-rufus-disco',
          '.nav-search-rufus-container',
          '#nav-flyout-rufus',
          '.rufus-panel-container',
          'div.rufus-chat-container',
          '[class^="rufus-"]',
          '#nile-inline_feature_div',
          '#nile-inline-btf_feature_div',
          '#rufus-dpx-atf-mission-pills-container',
          '.rufus-pill',
          '.s-ask-rufus-mshop-suggestion-container',
          '.s-suggestion-nile-desktop-container',
          '#dpx-rex-nice-widget-container',
          '.yo-ask-order-pill',
          '#shopTalk_feature_div',
        ],
        extraCss: ['body.rufus-docked-left { padding-left: 0 !important; margin-left: 0 !important; }'],
        block: ['/rufus/'],
      },
      {
        id: 'review-summary',
        name: 'AI review summaries',
        css: [
          '[data-csa-c-painter="review-highlights-experience"]',
          '.cr-reviews-ai-pills-t1',
          '.cr-reviews-ai-pills-t2',
          '.cs-summary-section',
          '.a-spacing-top-mini:has(> .ai-branding-icon)',
          '#nile-inline-insights_feature_div',
        ],
        match: [
          {
            candidates: 'span, p, div',
            texts: ['AI-generated from the text of customer reviews', 'KI-generiert aus dem Text von Kundenrezensionen'],
            maxLength: 80,
            hide: { closest: '[id$="_feature_div"]' },
          },
        ],
      },
    ],
  },
  {
    id: 'quora',
    site: 'Quora',
    hosts: ['quora.com', '*.quora.com'],
    features: [
      {
        id: 'ai-answers',
        name: 'AI bot answers',
        css: ['a[href="https://www.quora.com/ai_interviewer"]', '.q-box[class*="dom_annotate_question_answer_item_"]:has(img[src*="poe.multibot_app_icon"])'],
      },
    ],
  },
  {
    id: 'stack-exchange',
    site: 'Stack Overflow and Stack Exchange',
    hosts: ['stackoverflow.com', '*.stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net'],
    features: [
      {
        id: 'ai-assist',
        name: 'AI Assist',
        css: ['#nav-askstack', '.js-use-with-ai-button', '#mainbar > div:has(textarea#ask-stack-initial-question)', '#nav-sofa', '.js-sofa-sidebar-promo', 'a[href^="/ai-assist"]'],
      },
    ],
  },
  {
    id: 'github',
    site: 'GitHub',
    hosts: ['github.com'],
    features: [
      {
        id: 'copilot',
        name: 'Copilot',
        css: [
          '[data-testid="top-bar-actions"] > .hide-md:has([class*=" CopilotMenu__"])',
          'button[data-testid="copilot-popover-button"]',
          '[data-testid="side-nav-menu-item-COPILOT"]',
          '[data-component="SplitPageLayout.Sidebar"]:has(> [data-testid="copilot-code-view-side-panel"])',
          '.copilotPreview__container',
          '#blob-view-header-copilot-icon',
          '#copilot-button-container',
          '[data-testid="copilot-menu-items"]',
          '[role="menuitem"]:has(.octicon-copilot)',
          '[data-component="IconButton"]:has(> .octicon-copilot)',
          '[partial-name="copilot-code-chat"]',
          '[data-testid="copilot-diff-explain-button"]',
          '#copilot-md-menu-anchor-new_comment_field',
          '[data-test-id="copilot-actions-chat-button"]',
          'command-palette-item[data-item-title="Copilot"]',
          'li:has(> [data-tab-item="agents"])',
          'button:has(> svg.octicon-copilot)',
          'a:has(> svg.octicon-copilot)',
        ],
      },
    ],
  },
  {
    id: 'notion',
    site: 'Notion',
    hosts: ['notion.so', '*.notion.so', 'notion.site', '*.notion.site'],
    features: [{ id: 'notion-ai', name: 'Notion AI', css: ['.notion-assistant-corner-origin-container', 'a[href="/ai"]'] }],
  },
  {
    id: 'canva',
    site: 'Canva',
    hosts: ['canva.com'],
    features: [
      {
        id: 'canva-ai',
        name: 'Canva AI',
        css: ['button[aria-label="Help Assistant"]', '[aria-label="Canva AI"]', '[aria-label="Ask Canva"]', 'a[href="/dream-lab"]', 'a[href^="/ai/code"]'],
      },
    ],
  },
  {
    id: 'shops',
    site: 'Walmart, Target, Best Buy, eBay',
    hosts: ['walmart.com', 'target.com', 'bestbuy.com', 'ebay.*', 'ebay.co.uk', 'zillow.com'],
    features: [
      {
        id: 'assistants',
        name: 'AI shopping assistants and summaries',
        css: [
          '.unified-chat-component',
          '[data-testid="bulleted-summary"]',
          'button[aria-label="Ask Target"]',
          '[data-component-name="AiReviewSummary"]',
          '.srp-river-answer--FAQ_KW_SRP_MODULE',
          '[data-testid="voyager-omni-button"]',
        ],
      },
    ],
  },
  {
    id: 'imdb',
    site: 'IMDb',
    hosts: ['imdb.com', 'm.imdb.com'],
    features: [{ id: 'review-summary', name: 'AI review summaries', css: ['[data-testid="ai-review-summary"]'] }],
  },
  {
    id: 'atlassian',
    site: 'Atlassian (Jira, Confluence)',
    hosts: ['*.atlassian.net'],
    features: [{ id: 'rovo', name: 'Rovo / Atlassian Intelligence', css: ['[data-testid="ask-ai-button"]'] }],
  },
  {
    id: 'adobe',
    site: 'Adobe Acrobat',
    hosts: ['acrobat.adobe.com', 'documentcloud.adobe.com'],
    features: [{ id: 'assistant', name: 'AI Assistant', css: ['#genai-assistant-button'] }],
  },
  {
    id: 'spotify',
    site: 'Spotify',
    hosts: ['open.spotify.com'],
    features: [
      {
        id: 'dj',
        name: 'AI DJ',
        match: [{ candidates: 'a[href*="37i9dQZF1EYkqdzj48dyYq"]', any: true, hide: { closest: '[data-encore-id="card"], [role="group"], li' } }],
      },
    ],
  },
  {
    id: 'widgets',
    site: 'AI chat widgets (any site)',
    hosts: ['*'],
    features: [
      {
        id: 'chat-widgets',
        name: 'Embedded AI chat widgets',
        css: [
          '#kapa-widget-container',
          '.kapa-ai-class',
          '#gist-answers-widget',
          'molin-shop-ai',
          '#molin-chat-custom-button',
          'button[data-testid="ai-chat-button"]',
          'button#assistant-entry',
        ],
      },
    ],
  },
];

/** Rules that apply to a host, excluding the catch-all widget rule. */
export function siteRulesForHost(host: string): ShieldRule[] {
  return RULES.filter((r) => !r.hosts.includes('*') && ruleMatchesHost(r, host));
}

export function rulesForHost(host: string): ShieldRule[] {
  return RULES.filter((r) => ruleMatchesHost(r, host));
}
