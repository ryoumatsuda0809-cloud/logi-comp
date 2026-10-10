import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { QUANTITY_PRIMARY_UNITS, joinQuantity, quantityProblem, splitQuantity } from "@/lib/orderContent";

type State =
  | { mode: "split"; amount: string; unit: string; unreadUnit?: string }
  | { mode: "free"; text: string };

const init = (value: string): State => {
  const parts = splitQuantity(value);
  return parts
    ? { mode: "split", amount: parts.amount, unit: parts.unit, unreadUnit: parts.unreadUnit }
    : { mode: "free", text: value };
};

const emit = (s: State) => (s.mode === "free" ? s.text : joinQuantity(s.amount, s.unit));

type Props = {
  /** 数字の欄（自由入力のときは唯一の欄）の id。ラベルの htmlFor に合わせる */
  id: string;
  value: string;
  onChange: (value: string) => void;
};

/**
 * 数量を「数字の欄＋単位の選択」で入れる。AI の結果が「2キロ」「20箱」なら自動で振り分ける。
 * 「20箱（500kg）」のように1つの「数字＋単位」でない値は、今までどおりの1つの欄で扱う。
 * 親が持つ値は「12箱」の1つの文字列のまま（保存・書面・承認前のチェックは変えない）。
 */
export function QuantityField({ id, value, onChange }: Props) {
  const [state, setState] = useState<State>(() => init(value));
  const lastEmitted = useRef(value);

  // 親が別の値に差し替えたとき（AI 解析のやり直しなど）だけ、入れ直す
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setState(init(value));
    }
  }, [value]);

  const update = (next: State) => {
    const out = emit(next);
    lastEmitted.current = out;
    setState(next);
    onChange(out);
  };

  const problem = quantityProblem(value);

  if (state.mode === "free") {
    return (
      <>
        <Input id={id} value={state.text} aria-invalid={problem !== null} onChange={(e) => update({ mode: "free", text: e.target.value })} />
        {problem && <p className="mt-1 text-xs text-destructive">{problem}</p>}
      </>
    );
  }

  const needsUnit = state.amount.trim() !== "" && state.unit === "";
  const message = needsUnit
    ? state.unreadUnit
      ? `「${state.unreadUnit}」は単位として読み取れません。単位を選んでください`
      : "単位を選んでください"
    : problem;
  const options: string[] = [...QUANTITY_PRIMARY_UNITS];
  if (state.unit && !options.includes(state.unit)) options.push(state.unit);

  return (
    <>
      <div className="flex gap-2">
        <Input
          id={id}
          inputMode="decimal"
          value={state.amount}
          aria-invalid={message !== null}
          // 数字以外は入らない（単位は右の選択で入れる）。全角の数字は半角にする
          onChange={(e) => update({ ...state, amount: e.target.value.normalize("NFKC").replace(/[^\d.,]/g, "") })}
        />
        <select
          id={`${id}-unit`}
          aria-label="数量の単位"
          aria-invalid={needsUnit}
          value={state.unit}
          onChange={(e) => update({ ...state, unit: e.target.value, unreadUnit: undefined })}
          className="h-10 w-28 shrink-0 rounded-md border border-input bg-background px-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm"
        >
          <option value="">単位</option>
          {options.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      {message && <p className="mt-1 text-xs text-destructive">{message}</p>}
    </>
  );
}
