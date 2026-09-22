/* === 0.5 i18n (self-contained; Lite is a standalone build) === */
  var I18N = {
    zh: {
      pause: '暂停', paused: '已暂停', resume: '继续', restart: '重新开始', backMenu: '返回菜单',
      settings: '设置', editor: '导入和编辑', switchFull: '切换完整版',
      autoplay: 'Auto-Play',
      setTitle: '设置', setSpeed: '下落速度', setSize: '音符缩放', setRender: '渲染距离',
      setMaxFps: '帧率上限', 
      setOffset: '音频偏移', setProj: '判定框浮现', setMusic: '音乐音量', setSfx: '音效音量', setCompat: '兼容模式', setClose: '关闭',
      edTitle: '导入和编辑', edHint: '粘贴 JSON 格式的谱面。结构：{ metadata: {...}, notes: [...] }。notes 支持 type: tap / touch / slide（slide 带 nodes 数组）。',
      edImportChart: '导入谱面', edImportAudio: '导入音频', edLoad: '加载谱面', edClose: '关闭',
      resultAcc: 'Accuracy', resultRetry: '重试', resultBack: '返回菜单',
      chartErrFormat: '谱面格式错误', chartLoadFail: '加载谱面失败: ', loading: '加载中...',
      loadPhaseChart: '谱面', loadPhaseAudio: '音频', audioDecoding: '解码中...',
      errTimeout: '加载超时（网络较慢）', chartNoFile: '该难度没有谱面文件',
      loadFailHint: '加载失败：{err}。可再次点击开始重试。',
      audioFailSynth: '音频加载失败：{err}，已改用合成音。',
      backUp: '← 返回上一级', backAlbum: '返回专辑列表', diff: '难度 ',
      startGame: '开始', enterAlbum: '进入', albumKw: '专辑', trackKw: '曲目',
      navBack: '← 返回', navHome: '主页',
      errImport: '不支持文件导入', errAudioDecode: '音频解码失败（请尝试MP3格式）',
      errRead: '读取失败', errDecode: '解码失败', errAudioLoad: '音频加载失败', errNet: '网络错误',
      lang: '语言', songsSuffix: '首',
      srvLabel: '服务器', srvConnect: '连接', srvConnecting: '连接中...', srvOk: '已连接', srvFail: '连接失败'
    },
    en: {
      pause: 'Pause', paused: 'Paused', resume: 'Resume', restart: 'Restart', backMenu: 'Back to Menu',
      settings: 'Settings', editor: 'Import & Edit', switchFull: 'Switch to Full',
      autoplay: 'Auto-Play',
      setTitle: 'Settings', setSpeed: 'Scroll Speed', setSize: 'Note Scale', setRender: 'Render Distance',
      setMaxFps: 'Frame Rate Cap', 
      setOffset: 'Audio Offset', setProj: 'Hitbox Lead', setMusic: 'Music Volume', setSfx: 'SFX Volume', setCompat: 'Compat Mode', setClose: 'Close',
      edTitle: 'Import & Edit', edHint: 'Paste a JSON chart. Structure: { metadata: {...}, notes: [...] }. notes support type: tap / touch / slide (slide carries a nodes array).',
      edImportChart: 'Import Chart', edImportAudio: 'Import Audio', edLoad: 'Load Chart', edClose: 'Close',
      resultAcc: 'Accuracy', resultRetry: 'Retry', resultBack: 'Back to Menu',
      chartErrFormat: 'Chart format error', chartLoadFail: 'Chart load failed: ', loading: 'Loading...',
      loadPhaseChart: 'Chart', loadPhaseAudio: 'Audio', audioDecoding: 'Decoding...',
      errTimeout: 'Timed out (slow network)', chartNoFile: 'No chart file for this difficulty',
      loadFailHint: 'Load failed: {err}. Press Start to retry.',
      audioFailSynth: 'Audio failed: {err}. Using synth track.',
      backUp: '← Back', backAlbum: 'Back to album list', diff: 'Diff ',
      startGame: 'Start', enterAlbum: 'Enter', albumKw: 'Album', trackKw: 'Track',
      navBack: '← Back', navHome: 'Home',
      errImport: 'File import unsupported', errAudioDecode: 'Audio decode failed (try MP3)',
      errRead: 'Read failed', errDecode: 'Decode failed', errAudioLoad: 'Audio load failed', errNet: 'Network error',
      lang: 'Language', songsSuffix: ' songs',
      srvLabel: 'Server', srvConnect: 'Connect', srvConnecting: 'Connecting...', srvOk: 'Connected', srvFail: 'Connect failed'
    },
    ja: {
      pause: '一時停止', paused: '停止中', resume: '再開', restart: '最初から', backMenu: 'メニューへ戻る',
      settings: '設定', editor: 'インポートと編集', switchFull: '完全版へ',
      autoplay: 'Auto-Play',
      setTitle: '設定', setSpeed: '落下速度', setSize: 'ノーツ倍率', setRender: '描画距離',
      setMaxFps: 'フレームレート上限', 
      setOffset: '音声オフセット', setProj: '判定枠リード', setMusic: '音楽音量', setSfx: '効果音量', setCompat: '互換モード', setClose: '閉じる',
      edTitle: 'インポートと編集', edHint: 'JSON 譜面を貼り付け。構造: { metadata: {...}, notes: [...] }。notes は type: tap / touch / slide に対応（slide は nodes 配列を持つ）。',
      edImportChart: '譜面をインポート', edImportAudio: '音声をインポート', edLoad: '譜面を読込', edClose: '閉じる',
      resultAcc: '精度', resultRetry: 'リトライ', resultBack: 'メニューへ戻る',
      chartErrFormat: '譜面形式エラー', chartLoadFail: '譜面読込失敗: ', loading: '読込中...',
      loadPhaseChart: '譜面', loadPhaseAudio: '音声', audioDecoding: 'デコード中...',
      errTimeout: 'タイムアウト（回線が遅い）', chartNoFile: 'この難易度に譜面ファイルがありません',
      loadFailHint: '読み込み失敗: {err}。スタートで再試行できます。',
      audioFailSynth: '音声読み込み失敗: {err}。合成音を使用します。',
      backUp: '← 上へ戻る', backAlbum: 'アルバム一覧へ', diff: '難易度 ',
      startGame: 'スタート', enterAlbum: '進む', albumKw: 'アルバム', trackKw: '曲',
      navBack: '← 戻る', navHome: 'ホーム',
      errImport: 'ファイル入力非対応', errAudioDecode: '音声デコード失敗（MP3を試してください）',
      errRead: '読取り失敗', errDecode: 'デコード失敗', errAudioLoad: '音声読込失敗', errNet: 'ネットワークエラー',
      lang: '言語', songsSuffix: '曲',
      srvLabel: 'サーバー', srvConnect: '接続', srvConnecting: '接続中...', srvOk: '接続済み', srvFail: '接続失敗'
    }
  };
  var LANG_KEY = 'poluxis-lite-lang';
  function getLang() {
    try { var s = localStorage.getItem(LANG_KEY); if (s === 'zh' || s === 'en' || s === 'ja') return s; } catch (e) {}
    var nav = (navigator.language || 'zh').toLowerCase();
    if (nav.indexOf('ja') === 0) return 'ja';
    if (nav.indexOf('en') === 0) return 'en';
    return 'zh';
  }
  function setLang(l) { try { localStorage.setItem(LANG_KEY, l); } catch (e) {} }
  function L(key, vars) {
    var dict = I18N[getLang()] || I18N.zh;
    var str = dict[key] != null ? dict[key] : (I18N.en[key] != null ? I18N.en[key] : key);
    if (vars) { for (var k in vars) { if (vars.hasOwnProperty(k)) { str = str.split('{' + k + '}').join(String(vars[k])); } } }
    return str;
  }
  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      nodes[i].textContent = L(key);
    }
    /* Icon-only controls (e.g. the modal ✕): localize the tooltip and the
     * accessible name instead of the glyph itself. */
    var titled = document.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titled.length; j++) {
      var tKey = L(titled[j].getAttribute('data-i18n-title'));
      titled[j].setAttribute('title', tKey);
      titled[j].setAttribute('aria-label', tKey);
    }
  }

  I18N.zh = Object.assign(I18N.zh, {
    errRootObj: '根对象必须为对象', errNoMeta: '缺少 metadata', errBpm: 'metadata.bpm 必须为正数',
    errTitle: 'metadata.title 不能为空', errNotesArr: 'notes 必须为数组',
    errNoteBeat: 'note #{i} 缺少 beat', errNoteXY: 'note #{i} 缺少 x/y',
    errNoteType: 'note #{i} type 非法', errSlideNodes: 'slide note #{i} 缺少 nodes',
    errJsonParse: 'JSON 解析失败: ', errLoaded: '已加载: ', errReadFile: '已读取 ',
    errDecoding: '解码中…', errAudioLoaded: '音频已加载(', errImportFail: '导入失败', errClickLoad: '，点击「加载谱面」生效'
  });
  I18N.en = Object.assign(I18N.en, {
    errRootObj: 'Root object must be an object', errNoMeta: 'Missing metadata', errBpm: 'metadata.bpm must be positive',
    errTitle: 'metadata.title must not be empty', errNotesArr: 'notes must be an array',
    errNoteBeat: 'note #{i} missing beat', errNoteXY: 'note #{i} missing x/y',
    errNoteType: 'note #{i} has invalid type', errSlideNodes: 'slide note #{i} missing nodes',
    errJsonParse: 'JSON parse failed: ', errLoaded: 'Loaded: ', errReadFile: 'Read ',
    errDecoding: 'Decoding…', errAudioLoaded: 'Audio loaded (', errImportFail: 'Import failed', errClickLoad: ', click "Load Chart" to apply'
  });
  I18N.ja = Object.assign(I18N.ja, {
    errRootObj: 'ルートオブジェクトはオブジェクトである必要があります', errNoMeta: 'metadata がありません', errBpm: 'metadata.bpm は正の数である必要があります',
    errTitle: 'metadata.title は空にできません', errNotesArr: 'notes は配列である必要があります',
    errNoteBeat: 'note #{i} に beat がありません', errNoteXY: 'note #{i} に x/y がありません',
    errNoteType: 'note #{i} の type が不正です', errSlideNodes: 'slide note #{i} に nodes がありません',
    errJsonParse: 'JSON 解析失敗: ', errLoaded: '読込完了: ', errReadFile: '読取り完了 ',
    errDecoding: 'デコード中…', errAudioLoaded: '音声読込完了(', errImportFail: 'インポート失敗', errClickLoad: '、「読込」をクリックして適用'
  });
