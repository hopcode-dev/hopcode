/**
 * Lightweight i18n system for Hopcode.
 * Returns a JS snippet (string) to be injected into inline <script> blocks.
 * Call getI18nScript() in each HTML template.
 */

const en: Record<string, string> = {
  // Common
  'loading': 'Loading...',
  'cancel': 'Cancel',
  'delete': 'Delete',
  'send': 'Send',
  'close': 'Close',
  'save': 'Save',
  'copied': 'Copied!',
  'failed': 'Failed',
  'creating': 'Creating...',
  'error_generic': 'An error occurred',

  // Login
  'login.title': 'Hopcode - Login',
  'login.error_incorrect': 'Incorrect password',
  'login.placeholder_username': 'Username',
  'login.placeholder_password': 'Password',
  'login.btn': 'Login',

  // Portal
  'portal.title': 'Hopcode - Sessions',
  'portal.heading': 'Hopcode',
  'portal.btn_easy': 'Easy',
  'portal.btn_new': '+ New',
  'portal.btn_new_project': '+ New Project',
  'portal.mode_easy': 'Easy',
  'portal.mode_pro': 'Pro',
  'portal.btn_logout': 'Logout',
  'portal.age_just_now': 'just now',
  'portal.age_m': 'm ago',
  'portal.age_h': 'h ago',
  'portal.age_d': 'd ago',
  'portal.empty_title': 'No active sessions',
  'portal.empty_sub': 'Create one to get started',
  'portal.confirm_delete': 'Delete {name}?',
  'portal.rename_title': 'Rename session',
  'portal.delete_title': 'Delete session',
  'portal.lang_label': 'Language',

  // Easy Mode
  'easy.title': 'Hopcode Easy Mode',
  'easy.status.initializing': 'Starting Claude...',
  'easy.status.ready': 'Ready',
  'easy.status.thinking': 'Claude is thinking...',
  'easy.status.tool_running': 'Claude is working...',
  'easy.status.error': 'Error',
  'easy.status.reconnecting': 'Reconnecting...',
  'easy.input.placeholder': 'Describe what you want to build... (Hold {key} to speak)',
  'easy.input.placeholder_mobile': 'Describe what you want to build...',
  'easy.input.thinking': 'Thinking...',
  'easy.input.working': 'Working...',
  'easy.input.type_response': 'Type your response...',
  'easy.btn.menu': 'Menu',
  'easy.btn.voice_toggle': 'Voice/Keyboard',
  'easy.btn.stop': 'Stop',
  'easy.btn.hold_to_speak': 'Hold to speak',
  'easy.btn.release_to_send': 'Release to send',
  'easy.btn.release_to_cancel': '↑ Release to cancel',
  'easy.btn.upload': 'Upload file',
  'easy.btn.send': 'Send',
  'easy.tab.chat': 'Chat',
  'easy.tab.preview': 'Preview',

  // Welcome
  'easy.welcome.greeting': 'Welcome to Hopcode',
  'easy.welcome.sub': 'Pick a project and build something amazing with AI in under 5 minutes.',
  'easy.welcome.dashboard.title': 'Data Dashboard',
  'easy.welcome.dashboard.desc': 'A beautiful sales analytics dashboard with interactive charts, KPI cards, and trend analysis.',
  'easy.welcome.dashboard.time': '~3 min',
  'easy.welcome.game.title': 'Classic Snake Game',
  'easy.welcome.game.desc': 'A fully playable Snake game with score tracking, speed levels, and smooth animations.',
  'easy.welcome.game.time': '~2 min',
  'easy.welcome.portfolio.title': 'Personal Portfolio',
  'easy.welcome.portfolio.desc': 'A stunning personal website with smooth scroll animations, responsive design, and modern aesthetic.',
  'easy.welcome.portfolio.time': '~3 min',
  'easy.welcome.skip': 'Or just start chatting',

  // Welcome prompts (sent to Claude when user clicks a card)
  'easy.welcome.dashboard.prompt': 'Build me an impressive interactive sales analytics dashboard as a single HTML file. Include: 1) A header with company name and date range selector, 2) KPI cards showing Total Revenue, Orders, Avg Order Value, and Growth % with colored indicators, 3) A revenue trend line chart (use canvas or SVG, no external libs), 4) A pie/donut chart for sales by category, 5) A sortable top-10 products table with sparkline bars, 6) Make it responsive with a professional dark theme and smooth hover animations. Use realistic sample data for a tech accessories store. The file should be completely self-contained with no external dependencies.',
  'easy.welcome.game.prompt': 'Build me a polished Snake game as a single HTML file. Include: 1) A canvas-based game board with a grid, 2) Smooth snake movement with arrow key and swipe controls (mobile friendly), 3) Score display and high score tracking (localStorage), 4) Speed increases every 5 points, 5) Game over screen with restart button, 6) A clean modern UI with dark theme, subtle grid lines, glowing snake effect, and food animations, 7) Start screen with instructions. Make it completely self-contained, no external dependencies. Make the visual quality impressive with gradients and subtle effects.',
  'easy.welcome.portfolio.prompt': 'Build me a stunning personal portfolio website as a single HTML file. Include: 1) A hero section with animated gradient background, name "Alex Chen" and title "Creative Developer", with a subtle floating particle effect, 2) An About section with a brief bio and skill tags with hover effects, 3) A Projects section with 3 project cards that have image placeholders, hover lift animations and tech stack badges, 4) A Contact section with social links and a simple contact form (no backend needed), 5) Smooth scroll navigation with a sticky header that changes on scroll, 6) Fully responsive, modern glassmorphism design, dark theme. No external dependencies, all CSS and JS inline.',

  // Preview
  'easy.preview.share': 'Share',
  'easy.preview.refresh': 'Refresh',
  'easy.preview.open': 'Open',
  'easy.preview.get_started': '✨ Get Started',
  'easy.preview.fullscreen': 'Fullscreen',
  'easy.preview.share_title': 'Get shareable link',
  'easy.preview.empty_title': 'Web Preview',
  'easy.preview.empty_desc': 'Ask Claude to build a webpage and it will appear here automatically.',
  'easy.preview.empty_try': 'Try saying:',
  'easy.preview.empty_example': '"Build me a simple game"',

  // Menu
  'easy.menu.home': 'Home',
  'easy.menu.pro_mode': 'Pro Mode',
  'easy.menu.files': 'Files',
  'easy.menu.apps': 'Apps',
  'easy.menu.font_size': 'Font Size',
  'easy.menu.projects': 'Projects',
  'easy.menu.new_project': 'New Project',
  'easy.menu.lang': 'Language',

  // Files panel
  'easy.files.title': 'Files',
  'easy.files.collapse': 'Collapse',
  'easy.files.upload': 'Upload',
  'easy.files.new_folder': 'New Folder',
  'easy.files.empty': 'Empty folder',
  'easy.files.error_load': 'Failed to load',
  'easy.files.prompt_folder': 'Folder name:',

  // New project modal
  'easy.modal.new_project': 'New Project',
  'easy.modal.project_placeholder': 'Project name (e.g. sales-report)',
  'easy.modal.create': 'Create',

  // Voice
  'easy.voice.recording': 'Recording...',
  'easy.voice.processing': 'Processing...',
  'easy.voice.error': 'Voice recognition failed',
  'easy.voice.no_mic': 'Microphone not available',
  'easy.voice.send': 'Send',
  'easy.voice.hint_default': 'Swipe up to cancel',
  'easy.voice.hint_cancel': 'Release to cancel',
  'easy.voice.hint_confirm': 'Edit and tap Send, or press Enter',

  // Messages
  'easy.msg.cancelled': 'Cancelled.',
  'easy.msg.stopped': 'Claude has stopped. ',
  'easy.msg.restart': 'Restart Claude',
  'easy.msg.stuck': 'Claude seems to be taking a while...',
  'easy.msg.uploaded': 'I uploaded: ',
  'easy.msg.uploading': 'Uploading {n} file(s)...',
  'easy.msg.upload_failed': 'Upload failed: ',

  // Tool labels
  'tool.Read': 'Reading file',
  'tool.Write': 'Writing file',
  'tool.Edit': 'Editing file',
  'tool.Bash': 'Running command',
  'tool.Glob': 'Searching files',
  'tool.Grep': 'Searching code',
  'tool.working': 'Working',
  'tool.Agent': 'Researching',
  'tool.WebFetch': 'Fetching web',
  'tool.WebSearch': 'Searching web',
  'easy.tool.step': 'step {n}',
  'easy.tool.done': 'Completed {n} steps',

  // Pro Mode
  'pro.status.hold_to_speak': 'Hold {key} to speak',
  'pro.status.hold_here': 'Hold here to speak',
  'pro.status.connecting': 'Connecting...',
  'pro.status.reconnecting': 'Reconnecting...',
  'pro.status.ws_error': 'WS error',
  'pro.status.recording': 'Recording...',
  'pro.status.processing': 'Processing...',
  'pro.status.sending': 'Sending to terminal...',
  'pro.status.uploaded': 'Uploaded',
  'pro.status.uploading': 'Uploading...',
  'pro.status.mic_not_available': 'Mic not available',
  'pro.status.mic_needs_https': 'Mic needs HTTPS',
  'pro.status.mic_denied': 'Mic denied - check browser settings',
  'pro.status.mic_blocked': 'Mic blocked - not secure context',

  'pro.chat.placeholder': 'Message... (Hold {key} to speak, {paste}+V to paste images/files)',
  'pro.chat.placeholder_mobile': 'Message...',
  'pro.chat.btn_send': 'Send',
  'pro.chat.hold_to_speak': 'Hold to speak',
  'pro.chat.recording': 'Recording...',
  'pro.chat.voice_toggle': 'Switch voice/keyboard',
  'pro.chat.upload': 'Upload file',

  'pro.vp.hint_default': '↑ Swipe up to cancel  → Swipe right to send',
  'pro.vp.hint_cancel': '↑ Release to cancel',
  'pro.vp.hint_send': '→ Release to send',
  'pro.vp.hint_confirm': '{key}: send | Control: cancel',
  'pro.vp.btn_cancel': 'Cancel',
  'pro.vp.btn_send': 'Send ⏎',

  'pro.copy.title': 'Select & Copy',
  'pro.copy.copy_all': 'Copy All',
  'pro.copy.close': 'Close',

  'pro.paste.title': 'Paste content here:',
  'pro.paste.placeholder': 'Long press or Ctrl+V to paste...',
  'pro.paste.btn_file': '📎 File',

  'pro.upload.where': 'Where do you want to drop the file(s)?',
  'pro.upload.to_terminal': '📋 Paste to Terminal',
  'pro.upload.to_terminal_sub': 'Upload to ~/.hopcode/uploads/, paste path into terminal',
  'pro.upload.to_files': '📁 Save to Files',
  'pro.upload.to_files_sub': 'Browse and choose a folder in the file browser',

  'pro.menu.sessions': '📋 Sessions',
  'pro.menu.new_session': '+ New Session',
  'pro.menu.terminal': '⚙ Terminal',
  'pro.menu.floating_keys': '⌨ Floating Keys',
  'pro.menu.fk_add': '+ Add',
  'pro.menu.fk_hide': 'Hide',
  'pro.menu.fk_show': 'Show',
  'pro.menu.fk_reset': 'Reset',
  'pro.menu.fk_none': 'No floating keys',
  'pro.menu.files': '📁 Files',
  'pro.menu.home': '🏠 Home',
  'pro.menu.easy_mode': '🐸 Easy Mode',
  'pro.menu.classic_mode': '💬 Classic Mode',
  'pro.menu.chat_mode': '💬 Chat Mode',
  'pro.menu.devtools': 'DevTools',
  'pro.menu.no_sessions': 'No sessions',
  'pro.menu.confirm_delete': 'Delete this session?',
  'pro.menu.lang': 'Language',

  'pro.fb.title': 'Files',
  'pro.fb.upload': 'Upload files',
  'pro.fb.mkdir': 'New folder',
  'pro.fb.hidden': 'Toggle hidden files',
  'pro.fb.cwd': 'CWD',
  'pro.fb.drop_here': 'Drop files here',
  'pro.fb.empty': 'Empty directory',
  'pro.fb.back': '← Back',
  'pro.fb.folder_prompt': 'New folder name:',
  'pro.fb.upload_here': 'Upload Here',
  'pro.fb.pending': '{n} file(s) ready to upload — navigate to target folder',
  'pro.fb.error_load': 'Failed to load',
  'pro.fb.uploading_progress': 'Uploading... ({done}/{total})',
  'pro.fb.uploaded_count': 'Uploaded {n} file(s)',

  'pro.status.upload_failed': 'Upload failed',
  'pro.menu.error_load': 'Failed to load',
};

const zh: Record<string, string> = {
  // Common
  'loading': '加载中...',
  'cancel': '取消',
  'delete': '删除',
  'send': '发送',
  'close': '关闭',
  'save': '保存',
  'copied': '已复制！',
  'failed': '失败',
  'creating': '创建中...',
  'error_generic': '发生了错误',

  // Login
  'login.title': '立码 - 登录',
  'login.error_incorrect': '密码错误',
  'login.placeholder_username': '用户名',
  'login.placeholder_password': '密码',
  'login.btn': '登录',

  // Portal
  'portal.title': '立码 - 会话列表',
  'portal.heading': '立码',
  'portal.btn_easy': '简单模式',
  'portal.btn_new': '+ 新建',
  'portal.btn_new_project': '+ 新建项目',
  'portal.mode_easy': '简单',
  'portal.mode_pro': '专业',
  'portal.btn_logout': '退出',
  'portal.age_just_now': '刚刚',
  'portal.age_m': '分钟前',
  'portal.age_h': '小时前',
  'portal.age_d': '天前',
  'portal.empty_title': '暂无活跃会话',
  'portal.empty_sub': '创建一个会话开始使用',
  'portal.confirm_delete': '确认删除「{name}」？',
  'portal.rename_title': '重命名会话',
  'portal.delete_title': '删除会话',
  'portal.lang_label': '语言',

  // Easy Mode
  'easy.title': '立码 简单模式',
  'easy.status.initializing': 'Claude 启动中...',
  'easy.status.ready': '就绪',
  'easy.status.thinking': 'Claude 思考中...',
  'easy.status.tool_running': 'Claude 处理中...',
  'easy.status.error': '出错了',
  'easy.status.reconnecting': '重新连接中...',
  'easy.input.placeholder': '描述你想做什么...（按住 {key} 说话）',
  'easy.input.placeholder_mobile': '描述你想做什么...',
  'easy.input.thinking': '思考中...',
  'easy.input.working': '处理中...',
  'easy.input.type_response': '请输入您的回复...',
  'easy.btn.menu': '菜单',
  'easy.btn.voice_toggle': '语音/键盘',
  'easy.btn.stop': '停止',
  'easy.btn.hold_to_speak': '按住说话',
  'easy.btn.release_to_send': '松开发送',
  'easy.btn.release_to_cancel': '↑ 松开取消',
  'easy.btn.upload': '上传文件',
  'easy.btn.send': '发送',
  'easy.tab.chat': '对话',
  'easy.tab.preview': '预览',

  // Welcome
  'easy.welcome.greeting': '欢迎使用立码',
  'easy.welcome.sub': '选择一个项目，用 AI 在 5 分钟内构建出令人惊叹的作品。',
  'easy.welcome.dashboard.title': '数据仪表板',
  'easy.welcome.dashboard.desc': '带有交互式图表、KPI 卡片和趋势分析的精美销售分析仪表板。',
  'easy.welcome.dashboard.time': '约 3 分钟',
  'easy.welcome.game.title': '经典贪吃蛇',
  'easy.welcome.game.desc': '可完整游玩的贪吃蛇游戏，含分数追踪、速度等级和流畅动画。',
  'easy.welcome.game.time': '约 2 分钟',
  'easy.welcome.portfolio.title': '个人作品集',
  'easy.welcome.portfolio.desc': '精美的个人网站，带流畅滚动动画、响应式设计和现代美感。',
  'easy.welcome.portfolio.time': '约 3 分钟',
  'easy.welcome.skip': '或直接开始对话',

  // 欢迎卡片点击后发送的提示词
  'easy.welcome.dashboard.prompt': '帮我做一个漂亮的交互式销售数据分析仪表板，用单个 HTML 文件实现。要求：1) 顶部有公司名称和日期选择器，2) KPI 卡片显示总营收、订单数、客单价、增长率，带颜色指示，3) 用 canvas 或 SVG 画营收趋势折线图（不用外部库），4) 饼图/环形图展示各品类销售占比，5) 可排序的 Top 10 产品表格带迷你柱状图，6) 响应式布局，专业深色主题，丝滑的悬停动画。用一家数码配件店的模拟数据。文件完全独立，不依赖任何外部资源。',
  'easy.welcome.game.prompt': '帮我做一个精致的贪吃蛇游戏，用单个 HTML 文件实现。要求：1) 基于 canvas 的游戏画布带网格，2) 流畅的蛇移动，支持方向键和手势滑动（手机友好），3) 分数显示和最高分记录（用 localStorage），4) 每得 5 分速度提升一级，5) 游戏结束画面带重新开始按钮，6) 干净现代的 UI，深色主题，细微网格线，发光蛇身效果和食物动画，7) 开始画面带操作说明。完全独立，不依赖外部资源。视觉效果要精美，用渐变和细腻特效。',
  'easy.welcome.portfolio.prompt': '帮我做一个惊艳的个人作品集网站，用单个 HTML 文件实现。要求：1) 首屏区域带动态渐变背景，展示姓名"陈立"和头衔"创意开发者"，有微妙的浮动粒子效果，2) 关于我板块，简短个人介绍加技能标签带悬停效果，3) 项目展示区有 3 张项目卡片，带图片占位、悬停上浮动画和技术栈徽章，4) 联系方式区有社交链接和简单联系表单（不需要后端），5) 平滑滚动导航，固定头部会在滚动时变化，6) 完全响应式，现代毛玻璃风格设计，深色主题。不依赖外部资源，所有 CSS 和 JS 内联。',

  // Preview
  'easy.preview.share': '分享',
  'easy.preview.refresh': '刷新',
  'easy.preview.open': '打开',
  'easy.preview.get_started': '✨ 开始使用',
  'easy.preview.fullscreen': '全屏',
  'easy.preview.share_title': '获取分享链接',
  'easy.preview.empty_title': '网页预览',
  'easy.preview.empty_desc': '请 Claude 构建一个网页，完成后会自动在这里显示。',
  'easy.preview.empty_try': '试试说：',
  'easy.preview.empty_example': '"帮我做一个简单的游戏"',

  // Menu
  'easy.menu.home': '首页',
  'easy.menu.pro_mode': '专业模式',
  'easy.menu.files': '文件',
  'easy.menu.apps': '应用',
  'easy.menu.font_size': '字体大小',
  'easy.menu.projects': '项目',
  'easy.menu.new_project': '新建项目',
  'easy.menu.lang': '语言',

  // Files panel
  'easy.files.title': '文件',
  'easy.files.collapse': '折叠',
  'easy.files.upload': '上传',
  'easy.files.new_folder': '新建文件夹',
  'easy.files.empty': '空文件夹',
  'easy.files.error_load': '加载失败',
  'easy.files.prompt_folder': '文件夹名称：',

  // New project modal
  'easy.modal.new_project': '新建项目',
  'easy.modal.project_placeholder': '项目名称（例如：sales-report）',
  'easy.modal.create': '创建',

  // Voice
  'easy.voice.recording': '录音中...',
  'easy.voice.processing': '处理中...',
  'easy.voice.error': '语音识别失败',
  'easy.voice.no_mic': '麦克风不可用',
  'easy.voice.send': '发送',
  'easy.voice.hint_default': '上滑取消',
  'easy.voice.hint_cancel': '松手取消',
  'easy.voice.hint_confirm': '编辑后点发送，或按回车',

  // Messages
  'easy.msg.cancelled': '已取消。',
  'easy.msg.stopped': 'Claude 已停止。',
  'easy.msg.restart': '重启 Claude',
  'easy.msg.stuck': 'Claude 似乎需要更长时间...',
  'easy.msg.uploaded': '我上传了：',
  'easy.msg.uploading': '上传中，共 {n} 个文件...',
  'easy.msg.upload_failed': '上传失败：',

  // Tool labels
  'tool.Read': '读取文件',
  'tool.Write': '写入文件',
  'tool.Edit': '编辑文件',
  'tool.Bash': '执行命令',
  'tool.Glob': '搜索文件',
  'tool.Grep': '搜索代码',
  'tool.working': '处理中',
  'tool.Agent': '调研中',
  'tool.WebFetch': '抓取网页',
  'tool.WebSearch': '搜索网页',
  'easy.tool.step': '第{n}步',
  'easy.tool.done': '已完成 {n} 步操作',

  // Pro Mode
  'pro.status.hold_to_speak': '按住 {key} 说话',
  'pro.status.hold_here': '按住此处说话',
  'pro.status.connecting': '连接中...',
  'pro.status.reconnecting': '重新连接中...',
  'pro.status.ws_error': '连接出错',
  'pro.status.recording': '录音中...',
  'pro.status.processing': '处理中...',
  'pro.status.sending': '发送到终端...',
  'pro.status.uploaded': '已上传',
  'pro.status.uploading': '上传中...',
  'pro.status.mic_not_available': '麦克风不可用',
  'pro.status.mic_needs_https': '麦克风需要 HTTPS',
  'pro.status.mic_denied': '麦克风被拒绝 - 请检查浏览器设置',
  'pro.status.mic_blocked': '麦克风被屏蔽 - 非安全上下文',

  'pro.chat.placeholder': '发消息...（按住 {key} 说话，{paste}+V 粘贴图片/文件）',
  'pro.chat.placeholder_mobile': '发消息...',
  'pro.chat.btn_send': '发送',
  'pro.chat.hold_to_speak': '按住说话',
  'pro.chat.recording': '录音中...',
  'pro.chat.voice_toggle': '切换语音/键盘',
  'pro.chat.upload': '上传文件',

  'pro.vp.hint_default': '↑ 上滑取消  → 右滑发送',
  'pro.vp.hint_cancel': '↑ 松开取消',
  'pro.vp.hint_send': '→ 松开发送',
  'pro.vp.hint_confirm': '{key}：发送 | Ctrl：取消',
  'pro.vp.btn_cancel': '取消',
  'pro.vp.btn_send': '发送 ⏎',

  'pro.copy.title': '选择并复制',
  'pro.copy.copy_all': '全部复制',
  'pro.copy.close': '关闭',

  'pro.paste.title': '在此粘贴内容：',
  'pro.paste.placeholder': '长按或 Ctrl+V 粘贴...',
  'pro.paste.btn_file': '📎 文件',

  'pro.upload.where': '您想把文件放在哪里？',
  'pro.upload.to_terminal': '📋 粘贴到终端',
  'pro.upload.to_terminal_sub': '上传到 ~/.hopcode/uploads/，路径粘贴到终端',
  'pro.upload.to_files': '📁 保存到文件',
  'pro.upload.to_files_sub': '在文件浏览器中浏览并选择目标文件夹',

  'pro.menu.sessions': '📋 会话',
  'pro.menu.new_session': '+ 新建会话',
  'pro.menu.terminal': '⚙ 终端',
  'pro.menu.floating_keys': '⌨ 悬浮按键',
  'pro.menu.fk_add': '+ 添加',
  'pro.menu.fk_hide': '隐藏',
  'pro.menu.fk_show': '显示',
  'pro.menu.fk_reset': '重置',
  'pro.menu.fk_none': '无悬浮按键',
  'pro.menu.files': '📁 文件',
  'pro.menu.home': '🏠 首页',
  'pro.menu.easy_mode': '🐸 简单模式',
  'pro.menu.classic_mode': '💬 经典模式',
  'pro.menu.chat_mode': '💬 对话模式',
  'pro.menu.devtools': '开发者工具',
  'pro.menu.no_sessions': '暂无会话',
  'pro.menu.confirm_delete': '确认删除此会话？',
  'pro.menu.lang': '语言',

  'pro.fb.title': '文件',
  'pro.fb.upload': '上传文件',
  'pro.fb.mkdir': '新建文件夹',
  'pro.fb.hidden': '显示/隐藏隐藏文件',
  'pro.fb.cwd': '当前目录',
  'pro.fb.drop_here': '将文件拖放到此处',
  'pro.fb.empty': '空文件夹',
  'pro.fb.back': '← 返回',
  'pro.fb.folder_prompt': '新建文件夹名称：',
  'pro.fb.upload_here': '上传到此处',
  'pro.fb.pending': '{n} 个文件待上传 — 请导航到目标文件夹',
  'pro.fb.error_load': '加载失败',
  'pro.fb.uploading_progress': '上传中...（{done}/{total}）',
  'pro.fb.uploaded_count': '已上传 {n} 个文件',

  'pro.status.upload_failed': '上传失败',
  'pro.menu.error_load': '加载失败',
};

const translations: Record<string, Record<string, string>> = { en, zh };

/**
 * Returns a self-contained JS snippet for inline <script> blocks.
 * Provides: window._lang, window._t(key, params), window._setLang(lang), window._i18n
 */
export function getI18nScript(): string {
  return `
// --- i18n ---
var _i18n = ${JSON.stringify(translations)};
var _lang = (function() {
  var saved = localStorage.getItem('hopcode-lang');
  if (saved && _i18n[saved]) return saved;
  var nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('en')) return 'en';
  return 'zh';
})();
function _t(key, params) {
  var s = (_i18n[_lang] && _i18n[_lang][key]) || (_i18n['en'] && _i18n['en'][key]) || key;
  if (params) { for (var k in params) { s = s.split('{' + k + '}').join(params[k]); } }
  return s;
}
function _setLang(lang) {
  if (!_i18n[lang]) return;
  _lang = lang;
  localStorage.setItem('hopcode-lang', lang);
  location.reload();
}
function _applyI18n() {
  var els = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var key = el.getAttribute('data-i18n');
    var params = el.getAttribute('data-i18n-params');
    var p = params ? JSON.parse(params) : null;
    el.textContent = _t(key, p);
  }
  var pls = document.querySelectorAll('[data-i18n-placeholder]');
  for (var i = 0; i < pls.length; i++) {
    var el = pls[i];
    var key = el.getAttribute('data-i18n-placeholder');
    var params = el.getAttribute('data-i18n-params');
    var p = params ? JSON.parse(params) : null;
    el.placeholder = _t(key, p);
  }
  var tls = document.querySelectorAll('[data-i18n-title]');
  for (var i = 0; i < tls.length; i++) {
    var el = tls[i];
    var key = el.getAttribute('data-i18n-title');
    el.title = _t(key);
  }
}
document.addEventListener('DOMContentLoaded', _applyI18n);
// --- end i18n ---
`;
}

/** For server-side use: get translation for a key given a lang */
export function t(lang: string, key: string, params?: Record<string, string>): string {
  const dict = translations[lang] || translations['en']!;
  let s = dict![key] || translations['en']![key] || key;
  if (params) {
    for (const k in params) {
      s = s.split(`{${k}}`).join(params[k]);
    }
  }
  return s;
}

/** Detect language from request (cookie or Accept-Language header) */
export function detectLang(req: Request): string {
  // Check cookie first
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/hopcode-lang=(\w+)/);
  if (match && match[1] && translations[match[1]]) return match[1];
  // Check Accept-Language
  const accept = req.headers.get('accept-language') || '';
  if (accept.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}
