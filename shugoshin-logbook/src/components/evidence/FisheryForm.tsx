import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import type { FisheryData } from "@/hooks/useEvidence";
import {
  TARGET_SPECIES,
  COMMON_NON_TARGET_SPECIES,
  CATCH_NUMBER_LENGTH,
  LOT_NUMBER_LENGTH,
  isCatchNumberRequired,
  composeCatchNumber,
  formatTransferDate,
  validateCatchNumber,
  findTargetSpecies,
} from "@/lib/fisheryLaw";

interface FisheryFormProps {
  value: Partial<FisheryData>;
  onChange: (data: Partial<FisheryData>) => void;
  /** 施設に登録された届出番号（7桁）。未登録なら null で、16桁の直接入力に切り替わる */
  notificationNumber: string | null;
  /** 譲渡日として使う日時（到着打刻の時刻） */
  transferDate: Date;
}

const OTHER = "__other__";

export function FisheryForm({
  value,
  onChange,
  notificationNumber,
  transferDate,
}: FisheryFormProps) {
  // ロット3桁だけを入力する通常モードと、16桁を直接入力する退避モード
  const [manualMode, setManualMode] = useState(false);
  const [lotNumber, setLotNumber] = useState("");
  const [speciesChoice, setSpeciesChoice] = useState<string>("");

  const catchNumberNeeded = isCatchNumberRequired(
    value.species_id,
    value.weight_kg
  );
  const selectedTarget = findTargetSpecies(value.species_id);
  // 届出番号が未登録なら組み立てできないので直接入力にフォールバックする
  const canCompose = !!notificationNumber && !manualMode;

  const handleSpeciesSelect = (choice: string) => {
    setSpeciesChoice(choice);
    if (choice === OTHER) {
      onChange({ ...value, species: "", species_id: undefined, catch_number: undefined });
      return;
    }
    const target = TARGET_SPECIES.find((s) => s.id === choice);
    if (target) {
      onChange({ ...value, species: target.label, species_id: target.id });
    } else {
      // 対象外魚種を選んだら漁獲番号は不要になるので捨てる
      onChange({ ...value, species: choice, species_id: undefined, catch_number: undefined });
      setLotNumber("");
    }
  };

  const handleLotChange = (lot: string) => {
    const digits = lot.replace(/\D/g, "").slice(0, LOT_NUMBER_LENGTH);
    setLotNumber(digits);
    onChange({
      ...value,
      catch_number: digits
        ? composeCatchNumber(notificationNumber ?? "", transferDate, digits)
        : undefined,
    });
  };

  const validation = value.catch_number
    ? validateCatchNumber(value.catch_number, {
        notificationNumber: notificationNumber ?? undefined,
        transferDate,
      })
    : null;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-muted/40 p-5">
      <p className="text-sm font-semibold text-muted-foreground">
        水産物情報の入力
      </p>

      {/* ── 品目 ── */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fishery-species" className="text-base font-semibold">
          品目 <span className="text-destructive">*</span>
        </Label>
        <select
          id="fishery-species"
          value={speciesChoice}
          onChange={(e) => handleSpeciesSelect(e.target.value)}
          className="h-12 rounded-md border border-input bg-background px-3 text-base"
        >
          <option value="">選択してください</option>
          <optgroup label="漁獲番号が必要な魚種">
            {TARGET_SPECIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.note ? `（${s.note}）` : ""}
              </option>
            ))}
          </optgroup>
          <optgroup label="その他の魚種">
            {COMMON_NON_TARGET_SPECIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={OTHER}>その他（自由入力）</option>
          </optgroup>
        </select>

        {speciesChoice === OTHER && (
          <Input
            type="text"
            placeholder="魚種を入力"
            value={value.species ?? ""}
            onChange={(e) => onChange({ ...value, species: e.target.value })}
            className="h-12 text-base"
            autoComplete="off"
          />
        )}
      </div>

      {/* ── 重量 ── */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fishery-weight" className="text-base font-semibold">
          重量（kg） <span className="text-destructive">*</span>
        </Label>
        <Input
          id="fishery-weight"
          type="number"
          inputMode="decimal"
          min="0.1"
          step="0.1"
          placeholder="例: 450.5"
          value={value.weight_kg ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              weight_kg: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
          className="h-12 text-base"
        />
        {selectedTarget?.minWeightKg != null && !catchNumberNeeded && (
          <p className="text-sm text-muted-foreground">
            {selectedTarget.label}は{selectedTarget.minWeightKg}kg以上が対象です。
            重量を入力すると判定されます。
          </p>
        )}
      </div>

      {/* ── 漁獲番号（対象魚種のときのみ表示）── */}
      {catchNumberNeeded && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-4">
          <Label htmlFor="fishery-lot" className="text-base font-semibold">
            漁獲番号 <span className="text-destructive">*</span>
          </Label>

          {canCompose ? (
            <>
              {/* 届出番号と日付は自動。ドライバーが打つのはロット3桁のみ */}
              <div className="flex items-center gap-1.5 font-mono text-base">
                <span className="rounded bg-muted px-2 py-2 text-muted-foreground tabular-nums">
                  {notificationNumber}
                </span>
                <span className="rounded bg-muted px-2 py-2 text-muted-foreground tabular-nums">
                  {formatTransferDate(transferDate)}
                </span>
                <Input
                  id="fishery-lot"
                  type="text"
                  inputMode="numeric"
                  maxLength={LOT_NUMBER_LENGTH}
                  placeholder="000"
                  value={lotNumber}
                  onChange={(e) => handleLotChange(e.target.value)}
                  className="h-12 w-20 text-center font-mono text-lg tracking-widest"
                  autoComplete="off"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                届出番号と日付は自動で入ります。伝票のロット番号
                {LOT_NUMBER_LENGTH}桁だけ入力してください。
              </p>
              {value.catch_number && (
                <p className="font-mono text-sm text-foreground">
                  記録される番号: <strong>{value.catch_number}</strong>
                </p>
              )}
              <button
                type="button"
                onClick={() => setManualMode(true)}
                className="self-start text-sm text-muted-foreground underline underline-offset-2"
              >
                番号を直接入力する
              </button>
            </>
          ) : (
            <>
              <Input
                id="fishery-lot"
                type="text"
                maxLength={CATCH_NUMBER_LENGTH}
                placeholder={`${CATCH_NUMBER_LENGTH}桁の漁獲番号`}
                value={value.catch_number ?? ""}
                onChange={(e) =>
                  onChange({ ...value, catch_number: e.target.value })
                }
                className="h-12 font-mono text-base tracking-widest"
                autoComplete="off"
                autoCapitalize="characters"
              />
              <div className="flex items-center justify-between">
                {!notificationNumber ? (
                  <p className="text-sm text-muted-foreground">
                    この拠点は届出番号が未登録のため、番号全体を入力してください。
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => setManualMode(false)}
                    className="text-sm text-muted-foreground underline underline-offset-2"
                  >
                    ロット番号のみの入力に戻す
                  </button>
                )}
                <p className="text-xs text-muted-foreground tabular-nums">
                  {value.catch_number?.length ?? 0} / {CATCH_NUMBER_LENGTH}
                </p>
              </div>
            </>
          )}

          {/* 構造が合わなくても記録はできる（決定2: 警告のみ・ブロックしない） */}
          {validation && !validation.ok && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="flex flex-col gap-1">
                {validation.warnings.map((w) => (
                  <span key={w}>{w}</span>
                ))}
                <span className="text-muted-foreground">
                  伝票どおりの番号であればこのまま記録して構いません。
                </span>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* 対象外魚種であることの明示（なぜ欄が出ないかを分かるようにする） */}
      {value.species && !catchNumberNeeded && !selectedTarget && (
        <p className="text-sm text-muted-foreground">
          {value.species}は水産流通適正化法の対象外のため、漁獲番号の入力は不要です。
        </p>
      )}
    </div>
  );
}
