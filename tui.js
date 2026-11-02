import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { Show, createMemo, createSignal } from "solid-js";

/**
 * 在状态栏（prompt.footer.status）显示模型输出 token 速率。
 *
 * 读数口径与内置 assistant footer 的 tok/s 一致，保证两处数字不打架：
 *   (tokens.output + tokens.reasoning) / (本次请求开始 → 最后一个 token)
 * 生成中拿不到真实 token 数，用「已累计字符 × 每字符 token 比例」估算，比例在
 * 每步结束时用服务端 tokens 校正并做 EMA 平滑，所以会越用越准；每步结束时再用
 * 服务端 tokens 把这一步的数值校正成准确值。
 *
 * 没有 token 在输出时（工具调用间隙、思考停顿、回合结束）读数会掉到 0.0，
 * 不会停在上一次的数值上。
 *
 * 另外附带 TTFT（请求开始 → 首个 token 的延迟），用 session.step.started 的
 * started 做起点。这是定位「上下文变长后为什么越来越慢」的关键指标：
 * oc-tps 也有这项，但它是按会话平均；这里按每一步单独算，能看到单轮的真实延迟。
 *
 * 四个必须处理的坑：
 * 1. TUI 会多次 setup 同一个插件（多代实例共存），若每个实例都订阅事件并渲染，
 *    token 会重复计数、标签也会重复出现。所以状态与订阅收敛到 globalThis 单例，
 *    新实例接管时先拆掉旧实例。
 * 2. 事件流会重放，同一 event.id 可能投递多次，必须按 event.id 去重。
 * 3. 时间一律用 event.created（服务端时间），不要用本地 Date.now()。服务端可能把
 *    多个增量压在同一毫秒投递，本地时间还会受 read 批次影响，会把跨度压扁导致
 *    速率虚高好几倍。只有「多久没收到 token」这种静默判断才用本地时钟。
 * 4. 用累计均值而不是最近 N 秒的瞬时速率：瞬时速率在这套事件节奏下抖动很大
 *    （几十到几百来回跳），累计均值单调逼近最终值，读起来才可信。
 */

/** 数据太少（刚开口）时不给读数，免得先闪一个明显偏低的数字。 */
const MIN_SPAN_MS = 1200;
const MIN_CHARS = 40;
const TICK_MS = 500;
const SEEN_LIMIT = 8000;
/** 初始估值：约 2 字符/token（中文为主时的实测均值），之后按步校正。 */
const DEFAULT_TOKENS_PER_CHAR = 0.5;
/**
 * 静默判定：超过这么久没有收到任何 token（正文或思考），速率归零。
 * 用本地时钟判断「多久没收到增量」，因为服务端时间戳只在有事件时才前进。
 */
const IDLE_MS = 1000;
/**
 * 整轮结束（session.idle）后是否隐藏，而不是继续显示 0.0。
 * false：一直显示当前速率，空闲时就是 0.0；
 * true ：回合结束后整格消失，下次开始输出时再出现。
 */
const HIDE_WHEN_IDLE = false;
/**
 * 是否在速率后面附带 TTFT（首 token 延迟）。
 * 显示形如 `42.3 tok/s · TTFT 1.6s`；第一个 token 还没到时数字会实时累加，
 * 用来直观看到「卡了多久」。
 */
const SHOW_TTFT = true;
/**
 * TTFT 的最小可信值：低于这个值说明 step.started 与首个 token 几乎同毫秒，
 * 采集不到真实延迟，不如不显示这个数。
 */
const MIN_TTFT_MS = 200;
const STATE_KEY = Symbol.for("opencode.tok-speed-v2.state");
function shared() {
  const holder = globalThis;
  const existing = holder[STATE_KEY];
  if (existing) return existing;
  const [revision, setRevision] = createSignal(0);
  const state = {
    steps: new Map(),
    seen: new Set(),
    seenOrder: [],
    tokensPerChar: DEFAULT_TOKENS_PER_CHAR,
    revision,
    bump: () => setRevision(value => value + 1)
  };
  holder[STATE_KEY] = state;
  return state;
}
const state = shared();
function firstSight(id) {
  if (state.seen.has(id)) return false;
  state.seen.add(id);
  state.seenOrder.push(id);
  if (state.seenOrder.length > SEEN_LIMIT) {
    const dropped = state.seenOrder.shift();
    if (dropped !== undefined) state.seen.delete(dropped);
  }
  return true;
}
function charCount(text) {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}
function ensure(sessionID) {
  let step = state.steps.get(sessionID);
  if (!step) {
    step = {
      chars: 0,
      rate: 0,
      active: false,
      running: false
    };
    state.steps.set(sessionID, step);
  }
  return step;
}

/** 计时起点：请求开始时间；缺失时退回首个增量。 */
function baseOf(step) {
  return step.startedAt ?? step.firstAt;
}

/** 生成中的速率：累计字符折算的 token 数 / 已耗时。 */
function liveRate(step) {
  const base = baseOf(step);
  const end = step.lastAt ?? step.firstAt;
  if (base === undefined || end === undefined) return 0;
  const span = end - base;
  if (span < MIN_SPAN_MS || step.chars < MIN_CHARS) return 0;
  return step.chars * state.tokensPerChar / span * 1000;
}

/** 最近 IDLE_MS 内没收到 token 就算停止输出。 */
function isSilent(step, now) {
  if (step.lastLocalAt === undefined) return true;
  return now - step.lastLocalAt >= IDLE_MS;
}
function record(sessionID, delta, at) {
  const step = ensure(sessionID);
  if (!step.running) {
    // 插件在生成中途才加载时没有 step.started，就从这次增量开始计。
    step.running = true;
    step.chars = 0;
    step.firstAt = at;
  }
  step.active = true;
  if (step.firstAt === undefined) {
    step.firstAt = at;
    // 首个 token 到达：这一秒之前都是首 token 延迟。
    markFirstToken(step, at);
  }
  step.lastAt = at;
  step.lastLocalAt = Date.now();
  step.chars += charCount(delta);
}

/**
 * 记录首 token 到达，算出本步 TTFT。
 * 起点用 step.started 的 started（服务端记录的本轮请求开始时间）。
 * started 缺失（例如插件在生成中途才加载）时不猜，宁可不显示。
 */
function markFirstToken(step, at) {
  if (step.ttft !== undefined) return;
  const start = step.startedAt;
  if (start === undefined) return;
  const measured = at - start;
  // 时间戳异常（started 落在很久以前，或与首个 token 同毫秒）时不采信。
  if (measured >= MIN_TTFT_MS && measured < 10 * 60 * 1000) step.ttft = measured;
}
function startStep(sessionID, startedAt, created) {
  const step = ensure(sessionID);
  step.startedAt = startedAt;
  // 事件自带的 created 是服务端时刻，与本地钟的差就是两边的偏移。
  step.clockOffset = Date.now() - created;
  step.firstAt = undefined;
  step.lastAt = undefined;
  step.lastLocalAt = Date.now();
  step.chars = 0;
  step.rate = 0;
  step.ttft = undefined;
  step.active = true;
  step.running = true;
  state.bump();
}
function finishStep(sessionID, total, endedAt) {
  const step = ensure(sessionID);
  const base = baseOf(step);
  if (base !== undefined && total > 0) {
    const span = Math.max(0, (step.lastAt ?? endedAt) - base);
    if (span >= MIN_SPAN_MS) step.rate = total / span * 1000;
  }
  // 用本步真实的「token / 字符」比例校正后续估算。
  if (step.chars > 0 && total > 0) {
    const observed = total / step.chars;
    if (observed > 0.02 && observed < 3) state.tokensPerChar = (state.tokensPerChar + observed) / 2;
  }
  step.running = false;
  step.chars = 0;
  step.startedAt = undefined;
  step.firstAt = undefined;
  step.lastAt = undefined;
  state.bump();
}

/** 失败或整轮结束时收尾：清掉本步的计时状态。 */
function settle(sessionID, hide) {
  const step = state.steps.get(sessionID);
  if (!step) return;
  step.running = false;
  step.chars = 0;
  step.startedAt = undefined;
  step.firstAt = undefined;
  step.lastAt = undefined;
  if (hide) {
    step.active = false;
    step.rate = 0;
    step.ttft = undefined;
  }
  state.bump();
}

/** 毫秒格式化成秒：`0.4s` / `1.6s` / `134s`。 */
function formatTtft(ms) {
  const seconds = ms / 1000;
  if (seconds >= 10) return `${Math.round(seconds)}s`;
  return `${seconds.toFixed(1)}s`;
}
function SpeedLabel(props) {
  const context = usePlugin();
  const label = createMemo(() => {
    state.revision();
    const sessionID = props.sessionID;
    if (!sessionID) return undefined;
    const step = state.steps.get(sessionID);
    if (!step || !step.active) return undefined;
    let text = `${step.rate.toFixed(1)} tok/s`;
    if (SHOW_TTFT) {
      if (step.ttft !== undefined) {
        text += ` · TTFT ${formatTtft(step.ttft)}`;
      } else if (step.startedAt !== undefined && step.running) {
        // 首个 token 还没到：用服务端时间轴实时累加，用户能直接看到卡了多久。
        const elapsed = Date.now() - (step.clockOffset ?? 0) - step.startedAt;
        text += ` · TTFT ${formatTtft(Math.max(0, elapsed))}`;
      }
    }
    return {
      text,
      idle: step.rate <= 0.05
    };
  });
  return _$createComponent(Show, {
    get when() {
      return label();
    },
    children: current => (() => {
      var _el$ = _$createElement("text");
      _$insert(_el$, () => current().text);
      _$effect(_$p => _$setProp(_el$, "fg", current().idle ? context.theme.text.muted : context.theme.text.base, _$p));
      return _el$;
    })()
  });
}
export default Plugin.define({
  id: "opencode-tok-speed-v2",
  setup(context) {
    // 接管：先拆掉可能还活着的旧实例，避免重复订阅和重复渲染。
    state.dispose?.();
    const stops = [context.data.on("session.step.started", event => {
      if (!firstSight(event.id)) return;
      startStep(event.data.sessionID, event.data.started, event.created);
    }), context.data.on("session.text.delta", event => {
      if (!firstSight(event.id)) return;
      record(event.data.sessionID, event.data.delta, event.created);
    }), context.data.on("session.reasoning.delta", event => {
      if (!firstSight(event.id)) return;
      record(event.data.sessionID, event.data.delta, event.created);
    }), context.data.on("session.step.ended", event => {
      if (!firstSight(event.id)) return;
      const tokens = event.data.tokens;
      const total = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
      finishStep(event.data.sessionID, total, event.created);
    }), context.data.on("session.step.failed", event => {
      if (!firstSight(event.id)) return;
      settle(event.data.sessionID, false);
    }), context.data.on("session.idle", event => {
      if (!firstSight(event.id)) return;
      settle(event.data.sessionID, HIDE_WHEN_IDLE);
    })];
    const timer = setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const step of state.steps.values()) {
        if (!step.active) continue;
        // 没有 token 在输出就是 0，不要停在上一次的读数上。
        const next = isSilent(step, now) ? 0 : liveRate(step);
        if (Math.abs(next - step.rate) > 0.05) {
          step.rate = next;
          changed = true;
        }
        // 还在等首个 token 时速率恒为 0，得靠 TTFT 的实时计时驱动重绘。
        if (SHOW_TTFT && step.running && step.ttft === undefined && step.startedAt !== undefined) {
          changed = true;
        }
      }
      if (changed) state.bump();
    }, TICK_MS);
    const unsubscribeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: input => _$createComponent(SpeedLabel, {
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    let disposed = false;
    const dispose = () => {
      // 可能被调用两次：一次是新实例接管，一次是框架 cleanup。
      if (disposed) return;
      disposed = true;
      if (state.dispose === dispose) state.dispose = undefined;
      for (const stop of stops) stop();
      clearInterval(timer);
      unsubscribeSlot();
    };
    state.dispose = dispose;
    return dispose;
  }
});