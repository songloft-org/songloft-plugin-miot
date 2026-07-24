/**
 * 全屏播放器模块
 * 沉浸式播放界面：模糊背景 + 大封面/歌词 + 播放控制
 */

import { parseLrc, getCurrentLyricIndex } from './lrc-parser.js';
import {
    formatTime, fetchWithAuth, addStatusListener,
    getCurrentLyrics, getCurrentPosition, getCurrentDuration,
    getIsPlaying, getLastUpdateTime,
    togglePlayPause, previousSong, nextSong, stopPlaylist,
    playModes, togglePlayModePanel, toggleVolumePanel
} from './playback.js';
import { showSnackbar } from './utils.js';

const { apiGet, apiPost } = SongloftPlugin;

let isOpen = false;
let coverObjectUrl = null;
let coverUrl = '';
let fpLyrics = [];
let fpLyricUrl = '';
let isUserScrolling = false;
let resumeScrollTimer = null;
let lastHighlightIndex = -1;
let progressRAF = null;
let currentPage = 0;
let currentSongId = 0;
let isFavorited = false;
let favoriteLoading = false;

const RESUME_DELAY = 3000;
const LINE_HEIGHT = 48;
const COVER_FETCH_TIMEOUT_MS = 3500;

export function initFullscreenPlayer() {
    addStatusListener(onStatusUpdate);

    const pages = document.getElementById('fpPages');
    if (pages) {
        pages.addEventListener('scroll', onPagesScroll, { passive: true });
    }

    const lyricsContainer = document.getElementById('fpLyricsContainer');
    if (lyricsContainer) {
        lyricsContainer.addEventListener('scroll', onLyricsUserScroll, { passive: true });
        let touchStarted = false;
        lyricsContainer.addEventListener('touchstart', () => { touchStarted = true; }, { passive: true });
        lyricsContainer.addEventListener('touchend', () => { touchStarted = false; }, { passive: true });
        lyricsContainer.addEventListener('mousedown', () => { onLyricsScrollStart(); });
        lyricsContainer.addEventListener('touchmove', () => {
            if (touchStarted) onLyricsScrollStart();
        }, { passive: true });
    }

    document.getElementById('fpPlayBtn')?.addEventListener('click', togglePlayPause);
    document.getElementById('fpStopBtn')?.addEventListener('click', stopPlaylist);
    document.getElementById('fpPrevBtn')?.addEventListener('click', previousSong);
    document.getElementById('fpNextBtn')?.addEventListener('click', nextSong);
    document.getElementById('fpPlayModeBtn')?.addEventListener('click', togglePlayModePanel);
    document.getElementById('fpVolumeBtn')?.addEventListener('click', toggleVolumePanel);
    document.getElementById('fpFavoriteBtn')?.addEventListener('click', toggleFavorite);
}

export function openFullscreenPlayer() {
    const el = document.getElementById('fullscreenPlayer');
    if (!el || isOpen) return;

    isOpen = true;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';

    document.querySelector('.player-bar')?.classList.add('fp-hidden');

    syncFromPlaybackState();
    startProgressAnimation();
}

export function closeFullscreenPlayer() {
    const el = document.getElementById('fullscreenPlayer');
    if (!el || !isOpen) return;

    isOpen = false;
    el.classList.remove('open');
    document.body.style.overflow = '';

    stopProgressAnimation();

    const onEnd = () => {
        el.removeEventListener('transitionend', onEnd);
        document.querySelector('.player-bar')?.classList.remove('fp-hidden');
    };
    el.addEventListener('transitionend', onEnd);
}

function syncFromPlaybackState() {
    const lyrics = getCurrentLyrics();
    if (lyrics.length > 0 && lyrics !== fpLyrics) {
        fpLyrics = lyrics;
        renderLyrics(fpLyrics);
    }

    updateProgressDOM(getCurrentPosition(), getCurrentDuration());
}

// --- Status listener ---

function onStatusUpdate(status) {
    if (!isOpen) return;

    // Cover
    const newCoverUrl = status.current_song?.cover_url || '';
    if (newCoverUrl !== coverUrl) {
        coverUrl = newCoverUrl;
        loadCover(coverUrl);
    }

    // Lyrics
    const newLyricUrl = status.current_song?.lyric_url || '';
    if (newLyricUrl !== fpLyricUrl) {
        fpLyricUrl = newLyricUrl;
        if (newLyricUrl) {
            fetchAndRenderLyrics(newLyricUrl);
        } else {
            fpLyrics = [];
            renderLyrics([]);
        }
    }

    // Highlight current lyric line
    const position = status.position || 0;
    updateLyricHighlight(position);

    // Song info
    const song = status.current_song;
    const titleEl = document.getElementById('fpSongTitle');
    const artistEl = document.getElementById('fpSongArtist');
    if (titleEl) titleEl.textContent = song?.title || '暂无播放';
    if (artistEl) artistEl.textContent = song?.artist || '-';

    // Favorite status
    const songId = song?.id || 0;
    if (songId !== currentSongId) {
        currentSongId = songId;
        if (songId > 0) {
            checkFavoriteStatus(songId);
        } else {
            updateFavoriteUI(false);
        }
    }

    // Play button
    const playIcon = document.getElementById('fpPlayBtn')?.querySelector('.material-symbols-outlined');
    if (playIcon) playIcon.textContent = status.is_playing ? 'pause' : 'play_arrow';

    // Pulse animation
    const coverWrap = document.getElementById('fpCoverWrap');
    if (coverWrap) coverWrap.classList.toggle('playing', !!status.is_playing);

    // Play mode button
    if (status.play_mode) {
        const modeInfo = playModes.find(m => m.value === status.play_mode);
        if (modeInfo) {
            const modeIcon = document.getElementById('fpPlayModeBtn')?.querySelector('.material-symbols-outlined');
            const modeBtn = document.getElementById('fpPlayModeBtn');
            if (modeIcon) modeIcon.textContent = modeInfo.icon;
            if (modeBtn) modeBtn.title = modeInfo.label;
        }
    }

    // Volume icon sync
    if (status.volume !== undefined) {
        const volIcon = document.getElementById('fpVolumeBtn')?.querySelector('.material-symbols-outlined');
        if (volIcon) {
            if (status.volume <= 0) volIcon.textContent = 'volume_off';
            else if (status.volume < 50) volIcon.textContent = 'volume_down';
            else volIcon.textContent = 'volume_up';
        }
    }
}

// --- Cover ---

function loadCover(url) {
    const bgImage = document.getElementById('fpBgImage');
    const coverImg = document.getElementById('fpCoverImg');

    if (!url) {
        if (coverObjectUrl) {
            URL.revokeObjectURL(coverObjectUrl);
            coverObjectUrl = null;
        }
        if (coverImg) coverImg.src = '';
        if (bgImage) bgImage.style.backgroundImage = '';
        return;
    }

    fetchWithAuth(url, COVER_FETCH_TIMEOUT_MS).then(blob => {
        if (url !== coverUrl) return;
        if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
        coverObjectUrl = URL.createObjectURL(blob);
        if (coverImg) coverImg.src = coverObjectUrl;
        if (bgImage) bgImage.style.backgroundImage = `url(${coverObjectUrl})`;
    }).catch(() => {
        if (url !== coverUrl) return;
        if (coverImg) coverImg.src = '';
        if (bgImage) bgImage.style.backgroundImage = '';
    });
}

// --- Lyrics ---

function fetchAndRenderLyrics(lyricUrl) {
    if (!lyricUrl) return;

    fetchWithAuth(lyricUrl).then(blob => {
        if (!blob) return;
        return blob.text();
    }).then(rawText => {
        if (!rawText) return;
        let lrcText = rawText;
        try {
            const json = JSON.parse(rawText);
            if (json.lyric) lrcText = json.lyric;
            else if (json.success && json.data && json.data.lyric) lrcText = json.data.lyric;
            else if (json.data) lrcText = typeof json.data === 'string' ? json.data : '';
        } catch { /* not JSON */ }
        fpLyrics = parseLrc(lrcText);
        renderLyrics(fpLyrics);
    }).catch(err => {
        console.warn('全屏播放器: 获取歌词失败', err);
    });
}

function renderLyrics(lyrics) {
    const container = document.getElementById('fpLyricsContainer');
    if (!container) return;

    lastHighlightIndex = -1;

    if (!lyrics || lyrics.length === 0) {
        container.innerHTML = '<div class="fp-lyrics-empty">暂无歌词</div>';
        return;
    }

    container.innerHTML = '';

    lyrics.forEach((line, index) => {
        const el = document.createElement('div');
        el.className = 'fp-lyric-line';
        el.textContent = line.text || '...';
        el.dataset.index = index;
        container.appendChild(el);
    });

    updateLyricsPadding();
}

function updateLyricsPadding() {
    const container = document.getElementById('fpLyricsContainer');
    if (!container) return;

    const containerHeight = container.clientHeight;
    const padding = Math.max(0, (containerHeight - LINE_HEIGHT) / 2);

    container.style.paddingTop = padding + 'px';
    container.style.paddingBottom = padding + 'px';
}

function updateLyricHighlight(position) {
    if (fpLyrics.length === 0) return;

    const index = getCurrentLyricIndex(fpLyrics, position);
    if (index === lastHighlightIndex) return;

    const container = document.getElementById('fpLyricsContainer');
    if (!container) return;

    const prevEl = container.querySelector('.fp-lyric-line.active');
    if (prevEl) prevEl.classList.remove('active');

    lastHighlightIndex = index;

    if (index >= 0) {
        const lines = container.querySelectorAll('.fp-lyric-line');
        if (lines[index]) {
            lines[index].classList.add('active');
            scrollToLyric(index);
        }
    }
}

function scrollToLyric(index) {
    if (isUserScrolling) return;

    const container = document.getElementById('fpLyricsContainer');
    if (!container) return;

    const lines = container.querySelectorAll('.fp-lyric-line');
    if (!lines[index]) return;

    const containerHeight = container.clientHeight;
    const lineTop = lines[index].offsetTop;
    const targetScroll = lineTop - (containerHeight / 2) + (LINE_HEIGHT / 2);

    container.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: 'smooth'
    });
}

// --- Lyrics scroll detection ---

let scrollDetectTimer = null;

function onLyricsUserScroll() {
    // debounced detection: if scroll event fires from user interaction
}

function onLyricsScrollStart() {
    isUserScrolling = true;
    if (resumeScrollTimer) clearTimeout(resumeScrollTimer);
    resumeScrollTimer = setTimeout(() => {
        isUserScrolling = false;
        if (lastHighlightIndex >= 0) {
            scrollToLyric(lastHighlightIndex);
        }
    }, RESUME_DELAY);
}

// --- Page indicator ---

function onPagesScroll() {
    const pages = document.getElementById('fpPages');
    if (!pages) return;

    const scrollLeft = pages.scrollLeft;
    const pageWidth = pages.clientWidth;
    const newPage = Math.round(scrollLeft / pageWidth);

    if (newPage !== currentPage) {
        currentPage = newPage;
        updatePageIndicator();
    }
}

function updatePageIndicator() {
    const dots = document.querySelectorAll('#fpPageIndicator .fp-dot');
    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === currentPage);
    });
}

// --- Progress animation ---

function startProgressAnimation() {
    if (progressRAF) return;

    function animate() {
        if (!isOpen) {
            progressRAF = null;
            return;
        }

        const playing = getIsPlaying();
        const pos = getCurrentPosition();
        const dur = getCurrentDuration();
        const lastUpdate = getLastUpdateTime();

        let estimatedPos = pos;
        if (playing && lastUpdate > 0) {
            const elapsed = (performance.now() - lastUpdate) / 1000;
            estimatedPos = pos + elapsed;
        }
        if (dur > 0) estimatedPos = Math.min(estimatedPos, dur);

        updateProgressDOM(estimatedPos, dur);

        if (fpLyrics.length > 0) {
            updateLyricHighlight(estimatedPos);
        }

        progressRAF = requestAnimationFrame(animate);
    }

    progressRAF = requestAnimationFrame(animate);
}

function stopProgressAnimation() {
    if (progressRAF) {
        cancelAnimationFrame(progressRAF);
        progressRAF = null;
    }
}

function updateProgressDOM(position, duration) {
    const fill = document.getElementById('fpProgressFill');
    const thumb = document.getElementById('fpProgressThumb');
    const currentTimeEl = document.getElementById('fpCurrentTime');
    const totalTimeEl = document.getElementById('fpTotalTime');

    const percent = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;

    if (fill) fill.style.width = percent + '%';
    if (thumb) thumb.style.left = percent + '%';
    if (currentTimeEl) currentTimeEl.textContent = formatTime(position);
    if (totalTimeEl) totalTimeEl.textContent = formatTime(duration);
}

// --- Favorite ---

function checkFavoriteStatus(songId) {
    apiGet('/player/favorite/status?song_id=' + songId).then(data => {
        if (data?.success && data.data) {
            updateFavoriteUI(!!data.data.is_favorited);
        }
    }).catch(() => {
        updateFavoriteUI(false);
    });
}

function updateFavoriteUI(favorited) {
    isFavorited = favorited;
    const icon = document.getElementById('fpFavoriteIcon');
    const btn = document.getElementById('fpFavoriteBtn');
    if (icon) icon.textContent = favorited ? 'favorite' : 'favorite_border';
    if (btn) {
        btn.classList.toggle('is-favorited', favorited);
        btn.title = favorited ? '取消收藏' : '收藏';
    }
}

function toggleFavorite() {
    if (favoriteLoading || !currentSongId) return;
    favoriteLoading = true;
    const action = isFavorited ? 'remove' : 'add';
    apiPost('/player/favorite/toggle', { song_id: currentSongId, action }).then(data => {
        favoriteLoading = false;
        if (data?.success) {
            updateFavoriteUI(!!data.data?.is_favorited);
            showSnackbar(data.data?.is_favorited ? '已收藏' : '已取消收藏');
        } else {
            showSnackbar(data?.error || '操作失败');
        }
    }).catch(e => {
        favoriteLoading = false;
        showSnackbar('收藏操作失败');
    });
}
