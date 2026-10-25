import type { MinaService } from '../service/service';
import type { PlaylistManager, PlaylistManagerMap } from '../player/manager';
function ensure(current: () => boolean): void {
  if (!current())
    throw new Error('语音任务已取消');
}
/** 只包装调用，读写仍在原 manager 上执行，不复制播放状态。 */
export function guardedPlayers(players: PlaylistManagerMap, current: () => boolean): PlaylistManagerMap {
  const wrap = (manager: PlaylistManager | null): PlaylistManager | null => manager && new Proxy(manager, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== 'function')
        return value;
      return (...args: unknown[]) => {
        const mutators = ['play', 'playPlaylistFromSong', 'playWithSongs', 'playAtIndex', 'next', 'previous', 'stop', 'pause', 'resumePlayback', 'replayCurrent', 'prepareForNewPlayback', 'setPlayMode', 'setOnAdvanceHook', 'setAnnounceOnSongChange'];
        if (mutators.includes(String(name)))
          ensure(current);
        if (name === 'play')
          args[3] = { ...(args[3] as object || {}), isCurrent: current };
        if (name === 'playPlaylistFromSong')
          args[4] = current;
        if (name === 'playWithSongs')
          args[5] = current;
        if (name === 'playStandaloneSong') {
          ensure(current);
          args[2] = current;
        }
        if (name === 'playAtIndex' || name === 'next' || name === 'previous' || name === 'pause')
          args[name === 'playAtIndex' ? 1 : 0] = current;
        if (name === 'stop')
          args[1] = current;
        if (name === 'resumePlayback')
          args[0] = { ...(args[0] as object || {}), isCurrent: current };
        if (name === 'replayCurrent')
          args[1] = current;
        return value.apply(target, args);
      };
    },
  });
  return new Proxy(players, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (name === 'get')
        return (...args: unknown[]) => wrap(value.apply(target, args));
      if (name === 'getOrCreate')
        return async (...args: unknown[]) => { ensure(current); const manager = await value.apply(target, args); ensure(current); return wrap(manager); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export function guardedDevices(devices: MinaService, current: () => boolean): MinaService {
  return new Proxy(devices, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== 'function')
        return value;
      return (...args: unknown[]) => {
        ensure(current);
        if (name === 'playURL')
          args[4] = current;
        if (name === 'textToSpeech')
          args[3] = current;
        if (['stopPlay', 'pausePlay', 'pausePlayVerified', 'resumePlay', 'interruptAnswer'].includes(String(name)))
          args[2] = current;
        return value.apply(target, args);
      };
    },
  });
}
