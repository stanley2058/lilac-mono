import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FALLBACK_WORKING_INDICATORS,
  WORKING_INDICATOR_INTERVAL_MS,
  pastTense,
  rememberShownWorkingIndicator,
  settledWorkingIndicatorBucket,
  workingIndicatorAt,
  workingIndicatorBucket,
} from "../working-indicators";
import "./work-verb.css";

export const WorkingIndicatorsContext = createContext<readonly string[]>(
  FALLBACK_WORKING_INDICATORS,
);

export function useSettledWorkVerb(seed: string, durationMs: number | undefined): string {
  const words = useContext(WorkingIndicatorsContext);
  if (durationMs === undefined) return "Worked";
  return pastTense(
    workingIndicatorAt(words, seed, settledWorkingIndicatorBucket(seed, durationMs)),
  );
}

export function WorkVerb({ seed, startedAt }: { seed: string; startedAt: number }) {
  const words = useContext(WorkingIndicatorsContext);
  if (words.length < 2) return workingIndicatorAt(words, seed, 0);
  return <RotatingWorkVerb words={words} seed={seed} startedAt={startedAt} />;
}

function useWorkingIndicatorBucket(startedAt: number): number {
  const [bucket, setBucket] = useState(() => workingIndicatorBucket(Date.now() - startedAt));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      setBucket(workingIndicatorBucket(elapsed));
      timer = setTimeout(
        tick,
        WORKING_INDICATOR_INTERVAL_MS - (elapsed % WORKING_INDICATOR_INTERVAL_MS),
      );
    };
    tick();
    return () => clearTimeout(timer);
  }, [startedAt]);
  return bucket;
}

function RotatingWorkVerb(props: { words: readonly string[]; seed: string; startedAt: number }) {
  const bucket = useWorkingIndicatorBucket(props.startedAt);
  const word = workingIndicatorAt(props.words, props.seed, bucket);
  useEffect(() => {
    rememberShownWorkingIndicator(props.seed, bucket);
  }, [props.seed, bucket]);
  const [shown, setShown] = useState<{ word: string; previous?: string; key: number }>({
    word,
    key: 0,
  });
  if (shown.word !== word) setShown({ word, previous: shown.word, key: shown.key + 1 });
  const current = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = current.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown.key]);
  const exitKey = shown.key - 1;
  return (
    <span className="work-verb" style={width === undefined ? undefined : { width }}>
      {shown.previous === undefined ? null : (
        <span
          key={exitKey}
          aria-hidden="true"
          className="work-verb-word"
          data-work-verb="exit"
          onAnimationEnd={() =>
            setShown((state) =>
              state.key - 1 === exitKey ? { word: state.word, key: state.key } : state,
            )
          }
        >
          {shown.previous}
        </span>
      )}
      <span
        key={shown.key}
        ref={current}
        className="work-verb-word"
        data-work-verb={shown.key > 0 ? "enter" : undefined}
      >
        {shown.word}
      </span>
    </span>
  );
}
