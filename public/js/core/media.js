/**
 * 媒体舞台：数字人（或编辑结果）占主视图，本端画面是右下角的小浮窗。
 *
 * 本端预览默认隐藏——调试时关心的是数字人长什么样，自己的摄像头画面只会分散注意力。
 * 注意：隐藏的只是「显示」，不影响推流。video 模式该发布的摄像头流照常发布，
 * 否则数字人那侧就没有输入了。
 */
import { h } from './ui.js';

export function createMediaStage({
  title = '媒体',
  mainLabel = '数字人画面',
  localLabel = '本端预览',
  localHint,
  placeholder = '等待画面…',
} = {}) {
  const localVideo = h('video.pip-video', { autoplay: true, muted: true, playsinline: true });
  const localBox = h('div.local-pip', h('div.pip-label', localLabel), localVideo);
  localBox.style.display = 'none';   // 默认隐藏

  const remoteContainer = h('div.remote-grid');
  const placeholderEl = h('div.stage-placeholder', placeholder);

  const stage = h('div.media-stage', remoteContainer, placeholderEl, localBox);

  let localVisible = false;
  const localToggle = h('button.mini', { type: 'button', onclick: () => setLocalVisible(!localVisible) }, '显示本端画面');

  function setLocalVisible(visible) {
    localVisible = visible;
    localBox.style.display = visible ? '' : 'none';
    localToggle.textContent = visible ? '隐藏本端画面' : '显示本端画面';
  }

  const fullscreenBtn = h('button.mini', {
    type: 'button',
    onclick: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen?.();
    },
  }, '全屏');

  // 远端画面一出现就把占位文案撤掉，不用让 rtc.js 反过来知道舞台的存在。
  // 顺便按第一路远端流的真实宽高比调整舞台——数字人多是竖图，固定 16:9 会留一大片黑边。
  const observer = new MutationObserver(() => {
    const count = remoteContainer.children.length;
    placeholderEl.style.display = count ? 'none' : '';
    stage.classList.toggle('multi', count > 1);
    if (!count) stage.style.aspectRatio = '';

    const video = remoteContainer.querySelector('video');
    if (video && !video.dataset.aspectBound) {
      video.dataset.aspectBound = '1';
      const applyAspect = () => {
        if (!video.videoWidth || !video.videoHeight) return;
        if (remoteContainer.children.length > 1) return;  // 多路时用固定网格
        stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      };
      video.addEventListener('loadedmetadata', applyAspect);
      video.addEventListener('resize', applyAspect);
      applyAspect();
    }
  });
  observer.observe(remoteContainer, { childList: true });

  const element = h('section.card.media-card',
    h('div.card-head',
      h('div.card-title', title),
      h('div.card-actions', localToggle, fullscreenBtn),
      localHint ? h('div.card-hint', localHint) : null,
    ),
    h('div.card-body.media-body', stage),
  );

  return { element, localVideo, remoteContainer, setLocalVisible, mainLabel };
}
