/**
 * 歌单管理模块
 * 负责歌单加载、歌曲列表加载、歌单播放
 */

const { apiGet, apiPost } = SongloftPlugin;
import { showSnackbar, showLoading, hideLoading, showResult, getAccountId, getDeviceId, formatDuration } from './utils.js';
import { loadDeviceStatus } from './playback.js';
import { initPlaylistSearch, initSongSearch } from './search.js';

/**
 * 用插件 token 认证 fetch 封面资源
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
function fetchCoverWithAuth(url) {
    const { getAuthToken } = SongloftPlugin;
    const token = getAuthToken();
    const headers = {};
    if (token) {
        headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
    return fetch(url, { headers }).then(res => {
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        return res.blob();
    });
}

/**
 * HTML 转义辅助函数
 * @param {string} text - 需要转义的文本
 * @returns {string} 转义后的安全 HTML 文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 检查错误信息是否与服务器地址配置相关
 * @param {string} message - 错误信息
 * @returns {boolean}
 */
function isServerHostError(message) {
    if (!message) return false;
    const keywords = ['服务器地址', 'server host', '回环地址', 'localhost', 'loopback'];
    const lowerMsg = message.toLowerCase();
    return keywords.some(kw => lowerMsg.includes(kw.toLowerCase()));
}

/**
 * 打开/关闭歌单选择弹出层
 * @param {HTMLElement} trigger - 触发元素
 */
export function togglePlaylistSelectPanel(trigger) {
    const panel = document.getElementById('playlistSelectPanel');
    const backdrop = document.getElementById('playlistSelectBackdrop');
    const arrow = document.querySelector('.playlist-selector-arrow');

    if (panel.classList.contains('show')) {
        closePlaylistSelectPanel();
        return;
    }

    // 定位面板在选择栏下方
    const rect = trigger.getBoundingClientRect();
    panel.style.top = rect.bottom + 'px';

    backdrop.style.display = 'block';
    panel.classList.add('show');
    if (arrow) arrow.classList.add('expanded');

    const searchInput = document.getElementById('playlistSearchInput');
    if (searchInput) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
        setTimeout(() => searchInput.focus(), 100);
    }
}

/**
 * 关闭歌单选择弹出层
 */
export function closePlaylistSelectPanel() {
    const panel = document.getElementById('playlistSelectPanel');
    const backdrop = document.getElementById('playlistSelectBackdrop');
    const arrow = document.querySelector('.playlist-selector-arrow');

    panel.classList.remove('show');
    backdrop.style.display = 'none';
    if (arrow) arrow.classList.remove('expanded');
}

/**
 * 选择歌单后更新显示并加载歌曲
 * @param {string|number} id - 歌单 ID
 * @param {string} name - 歌单名称
 * @param {number} count - 歌曲数量
 */
export function selectPlaylist(id, name, count) {
    // 更新隐藏 select 的值
    const playlistSelect = document.getElementById('playlistSelect');
    if (playlistSelect) playlistSelect.value = id;

    // 更新显示文本
    const selectorText = document.getElementById('playlistSelectorText');
    if (selectorText) {
        selectorText.textContent = name + ' (' + (count || 0) + ')';
    }

    // 高亮选中项
    document.querySelectorAll('.playlist-select-item').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-id') == id);
    });

    // 关闭面板
    closePlaylistSelectPanel();

    // 加载歌曲
    loadPlaylistSongs(id);
}

/**
 * 加载歌单列表
 * @returns {Promise} 歌单加载 Promise
 */
export function loadPlaylists() {
    showLoading();
    return apiGet('/playlists').then(data => {
        hideLoading();
        if (!data.success || !data.data) {
            showResult(data);
            const errMsg = data.error || data.message || '未知错误';
            if (isServerHostError(errMsg)) {
                showSnackbar('加载歌单失败：' + errMsg + ' 请切换到「设置」页面配置服务器地址。', 'error');
            } else {
                showSnackbar('加载歌单失败：' + errMsg, 'error');
            }
            return;
        }

        // 歌单为空且有提示消息时，显示 snackbar
        if (data.data.length === 0 && data.message) {
            if (isServerHostError(data.message)) {
                showSnackbar(data.message + ' 请切换到「设置」页面配置服务器地址。', 'warning');
            } else {
                showSnackbar(data.message, 'warning');
            }
        }

        const select = document.getElementById('playlistSelect');
        if (!select) return;

        select.innerHTML = '<option value="">请选择歌单</option>';

        data.data.forEach(playlist => {
            const option = document.createElement('option');
            option.value = playlist.id;
            const isBuiltIn = playlist.labels && playlist.labels.includes('built_in');
            option.textContent = playlist.name + (isBuiltIn ? ' [内置]' : '') + ' (' + (playlist.song_count || 0) + ')';
            select.appendChild(option);
        });

        // 渲染弹出面板列表
        const playlistSelectList = document.getElementById('playlistSelectList');
        if (playlistSelectList) {
            playlistSelectList.innerHTML = '';
            data.data.forEach(playlist => {
                const item = document.createElement('div');
                item.className = 'playlist-select-item';
                item.setAttribute('data-id', playlist.id);

                item.innerHTML = `
                    <span class="material-symbols-outlined">queue_music</span>
                    <div class="playlist-select-item-info">
                        <div class="playlist-select-item-name">${escapeHtml(playlist.name)}</div>
                        <div class="playlist-select-item-count">${playlist.song_count || 0} 首歌曲</div>
                    </div>
                `;

                item.addEventListener('click', () => {
                    selectPlaylist(playlist.id, playlist.name, playlist.song_count);
                });

                playlistSelectList.appendChild(item);
            });
        }

        initPlaylistSearch();

        // 上报歌单加载事件
        if (window.tracely) {
            window.tracely.reportEvent('playlist_load', { playlist_count: data.data.length });
        }

        showResult(data);
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        if (isServerHostError(error.message)) {
            showSnackbar('加载歌单失败：' + error.message + ' 请切换到「设置」页面配置服务器地址。', 'error');
        } else {
            showSnackbar('加载歌单失败：' + error.message, 'error');
        }
    });
}

/**
 * 加载歌单歌曲列表
 * @param {string} playlistId - 歌单 ID
 */
export function loadPlaylistSongs(playlistId) {
    const songList = document.getElementById('songList');
    if (!songList) return Promise.resolve();

    if (!playlistId) {
        songList.innerHTML = '<div class="song-list-empty">请选择歌单</div>';
        return Promise.resolve();
    }

    showLoading();
    return apiGet('/playlists/' + playlistId + '/songs').then(data => {
        hideLoading();
        if (!data.success || !data.data) {
            showResult(data);
            showSnackbar('加载歌曲失败：' + (data.error || data.message || '未知错误'), 'error');
            return;
        }

        songList.innerHTML = '';

        data.data.forEach((song, index) => {
            const item = document.createElement('div');
            item.className = 'song-item';
            item.setAttribute('data-index', index);

            // 封面 - 用认证 fetch 获取；无封面时显示占位音符图标，避免裂图
            const coverWrap = document.createElement('div');
            coverWrap.className = 'song-item-cover-wrap';
            const coverImg = document.createElement('img');
            coverImg.className = 'song-item-cover';
            coverImg.alt = song.title;
            const coverPlaceholder = document.createElement('span');
            coverPlaceholder.className = 'material-symbols-outlined song-item-cover-placeholder';
            coverPlaceholder.textContent = 'music_note';
            coverWrap.appendChild(coverImg);
            coverWrap.appendChild(coverPlaceholder);
            if (song.cover_url) {
                // 延迟获取封面，避免阻塞列表渲染
                fetchCoverWithAuth(song.cover_url).then(blob => {
                    if (blob) {
                        const reader = new FileReader();
                        reader.onload = () => { coverImg.src = reader.result; };
                        reader.readAsDataURL(blob);
                    }
                }).catch(() => {
                    // 封面获取失败，保持占位图标
                });
            }
            item.appendChild(coverWrap);

            // 序号
            const indexSpan = document.createElement('span');
            indexSpan.className = 'song-item-index';
            indexSpan.textContent = (index + 1);

            // 文字区域（标题 + 艺术家）
            const textDiv = document.createElement('div');
            textDiv.className = 'song-item-content';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'song-item-title';
            titleDiv.textContent = song.title;

            const artistDiv = document.createElement('div');
            artistDiv.className = 'song-item-subtitle';
            artistDiv.textContent = song.artist || '未知艺术家';

            textDiv.appendChild(titleDiv);
            textDiv.appendChild(artistDiv);

            item.appendChild(indexSpan);
            item.appendChild(textDiv);

            // 时长
            if (song.duration) {
                const durationSpan = document.createElement('span');
                durationSpan.className = 'song-item-duration';
                durationSpan.textContent = formatDuration(song.duration);
                item.appendChild(durationSpan);
            }

            // 点击歌曲直接播放
            item.addEventListener('click', () => {
                playSongAtIndex(index);
            });

            songList.appendChild(item);
        });

        initSongSearch();

        // 上报歌单选择事件
        if (window.tracely) {
            const playlistSelect = document.getElementById('playlistSelect');
            const selectedOption = playlistSelect ? playlistSelect.options[playlistSelect.selectedIndex] : null;
            window.tracely.reportEvent('playlist_select', {
                playlist_id: playlistId,
                playlist_name: selectedOption ? selectedOption.textContent : '',
                song_count: data.data.length,
            });
        }

        showResult(data);
        showSnackbar('已加载 ' + data.data.length + ' 首歌曲', 'success');
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('加载歌曲失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/playlists/' + playlistId + '/songs', error: error.message });
        }
    });
}

/**
 * 播放指定索引的歌曲
 * @param {number} index - 歌曲索引
 */
export function playSongAtIndex(index) {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const playlistSelect = document.getElementById('playlistSelect');
    const playlistId = playlistSelect ? playlistSelect.value : '';
    if (!playlistId) {
        showSnackbar('请先选择歌单', 'error');
        return;
    }

    const playModeBtn = document.getElementById('playModeBtn');
    const playMode = playModeBtn ? (playModeBtn.getAttribute('data-mode') || 'loop') : 'loop';

    showLoading();
    apiPost('/player/play', {
        account_id: accountId,
        device_id: deviceId,
        playlist_id: parseInt(playlistId),
        start_index: index,
        play_mode: playMode
    }).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('开始播放', 'success');
            // 高亮当前歌曲
            highlightSongItem(index);
            if (window.tracely) {
                window.tracely.reportEvent('song_play', {
                    playlist_id: playlistId,
                    start_index: index,
                    play_mode: playMode,
                });
            }
            loadDeviceStatus();
        } else {
            const errMsg = data.error || data.message || '未知错误';
            if (isServerHostError(errMsg)) {
                showSnackbar('播放失败：' + errMsg + ' 请切换到「设置」页面配置服务器地址。', 'error');
            } else {
                showSnackbar('播放失败：' + errMsg, 'error');
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('播放失败：' + error.message, 'error');
    });
}

/**
 * 高亮指定索引的歌曲项
 * @param {number} index - 歌曲索引
 */
export function highlightSongItem(index) {
    const songList = document.getElementById('songList');
    if (!songList) return;
    // 移除所有 active
    songList.querySelectorAll('.song-item.active').forEach(el => el.classList.remove('active'));
    // 添加 active
    const target = songList.querySelector(`.song-item[data-index="${index}"]`);
    if (target) {
        target.classList.add('active');
    }
}

/**
 * 播放歌单（从头开始）
 */
export function playPlaylist() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const playlistSelect = document.getElementById('playlistSelect');
    const playlistId = playlistSelect ? playlistSelect.value : '';
    if (!playlistId) {
        showSnackbar('请先选择歌单', 'error');
        return;
    }

    const playModeBtn = document.getElementById('playModeBtn');
    const playMode = playModeBtn ? (playModeBtn.getAttribute('data-mode') || 'loop') : 'loop';

    showLoading();
    apiPost('/player/play', {
        account_id: accountId,
        device_id: deviceId,
        playlist_id: parseInt(playlistId),
        start_index: 0,
        play_mode: playMode
    }).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('开始播放歌单', 'success');
            // 上报歌曲播放事件
            if (window.tracely) {
                window.tracely.reportEvent('song_play', {
                    playlist_id: playlistId,
                    start_index: 0,
                    play_mode: playMode,
                });
            }
            loadDeviceStatus();
        } else {
            const errMsg = data.error || data.message || '未知错误';
            if (isServerHostError(errMsg)) {
                showSnackbar('播放失败：' + errMsg + ' 请切换到「设置」页面配置服务器地址。', 'error');
            } else {
                showSnackbar('播放失败：' + errMsg, 'error');
            }
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/player/play', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('播放失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/player/play', error: error.message });
        }
    });
}

/**
 * 播放指定 URL
 */
export function playUrl() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const playUrlInput = document.getElementById('playUrlInput');
    const url = playUrlInput ? playUrlInput.value.trim() : '';
    if (!url) {
        showSnackbar('请输入音频 URL', 'error');
        return;
    }

    showLoading();
    apiPost('/mina/play-url', { account_id: accountId, device_id: deviceId, url: url }).then(data => {
        hideLoading();
        showResult(data);
        if (data.success) {
            showSnackbar('URL 播放开始', 'success');
            // 上报 URL 播放事件
            if (window.tracely) {
                window.tracely.reportEvent('url_play', { url: url });
            }
        } else {
            showSnackbar('URL 播放失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/mina/play-url', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        showSnackbar('URL 播放失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/mina/play-url', error: error.message });
        }
    });
}

/**
 * 让音箱播报指定文字（TTS）
 */
export function playTTS() {
    const accountId = getAccountId();
    if (!accountId) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;

    const ttsInput = document.getElementById('ttsInput');
    const text = ttsInput ? ttsInput.value.trim() : '';
    if (!text) {
        showSnackbar('请输入要播报的文字', 'error');
        return;
    }

    console.info('[MIoT TTS] sending request', {
        account_id: accountId,
        device_id: deviceId,
        text_length: text.length,
    });

    showLoading();
    apiPost('/mina/tts', { account_id: accountId, device_id: deviceId, text: text }).then(data => {
        hideLoading();
        showResult(data);
        console.info('[MIoT TTS] response', {
            success: !!data.success,
            error: data.error || data.message || '',
        });
        if (data.success) {
            showSnackbar('已开始播报', 'success');
            if (window.tracely) {
                window.tracely.reportEvent('tts_play', {});
            }
        } else {
            showSnackbar('播报失败：' + (data.error || data.message || '未知错误'), 'error');
            if (window.tracely) {
                window.tracely.reportEvent('api_error', { path: '/mina/tts', error: data.error || data.message || '未知错误' });
            }
        }
    }).catch(error => {
        hideLoading();
        showResult({ error: error.message });
        console.warn('[MIoT TTS] request failed', error);
        showSnackbar('播报失败：' + error.message, 'error');
        if (window.tracely) {
            window.tracely.reportEvent('api_error', { path: '/mina/tts', error: error.message });
        }
    });
}
