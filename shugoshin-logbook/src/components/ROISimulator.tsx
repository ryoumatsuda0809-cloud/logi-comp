import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, AlertTriangle } from "lucide-react";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";

// ── 定数 ──
const ADMIN_MIN_PER_ORDER = 10;
const ADMIN_HOURLY_RATE = 1500;
const WAITING_RATE_PER_MIN = 60;
const WORKING_DAYS_PER_MONTH = 22;
const LATE_PAYMENT_ANNUAL_RATE = 0.146;
const GMEN_THRESHOLD_MIN = 60;

export default function ROISimulator() {
  const [orderCount, setOrderCount] = useState(15);
  const [waitingMin, setWaitingMin] = useState(30);
  const [monthlyPayment, setMonthlyPayment] = useState(2000); // 万円

  // ── Gain 計算 ──
  const adminSaving =
    (orderCount * ADMIN_MIN_PER_ORDER / 60) * ADMIN_HOURLY_RATE * WORKING_DAYS_PER_MONTH;
  const operationGain =
    orderCount * waitingMin * WAITING_RATE_PER_MIN * WORKING_DAYS_PER_MONTH;
  const totalGain = adminSaving + operationGain;

  // ── Pain 計算 ──
  const latePaymentRisk =
    Math.round((monthlyPayment * 10000 * LATE_PAYMENT_ANNUAL_RATE) / 12);
  const isGmenWarning = waitingMin > GMEN_THRESHOLD_MIN;

  // ── アニメーション ──
  const animAdminSaving = useAnimatedNumber(adminSaving);
  const animOperationGain = useAnimatedNumber(operationGain);
  const animTotalGain = useAnimatedNumber(totalGain);
  const animLatePayment = useAnimatedNumber(latePaymentRisk);

  const fmt = (n: number) => `¥${n.toLocaleString()}`;

  return (
    <div className="space-y-8">
      {/* ── 入力スライダー ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">入力パラメーター</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {/* A: 手配件数 */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-base text-muted-foreground">1日の手配・荷受件数</span>
              <span className="text-2xl font-bold text-foreground">{orderCount}<span className="text-base font-normal text-muted-foreground ml-1">件</span></span>
            </div>
            <Slider
              value={[orderCount]}
              onValueChange={([v]) => setOrderCount(v)}
              min={1}
              max={50}
              step={1}
            />
          </div>

          {/* B: 待機時間 */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-base text-muted-foreground">1件あたりの平均待機時間</span>
              <span className="text-2xl font-bold text-foreground">{waitingMin}<span className="text-base font-normal text-muted-foreground ml-1">分</span></span>
            </div>
            <Slider
              value={[waitingMin]}
              onValueChange={([v]) => setWaitingMin(v)}
              min={0}
              max={120}
              step={5}
            />
          </div>

          {/* C: 月間支払総額 */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-base text-muted-foreground">月間の委託代金の支払総額</span>
              <span className="text-2xl font-bold text-foreground">{monthlyPayment.toLocaleString()}<span className="text-base font-normal text-muted-foreground ml-1">万円</span></span>
            </div>
            <Slider
              value={[monthlyPayment]}
              onValueChange={([v]) => setMonthlyPayment(v)}
              min={100}
              max={5000}
              step={100}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Gain ── */}
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-success text-lg">
            <TrendingUp className="h-5 w-5" />
            Gain: 月間創出利益
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between text-base">
            <span className="text-muted-foreground">事務コスト削減</span>
            <span className="font-mono font-semibold text-foreground">{fmt(animAdminSaving)}</span>
          </div>
          <div className="flex justify-between text-base">
            <span className="text-muted-foreground">稼働増による潜在利益</span>
            <span className="font-mono font-semibold text-foreground">{fmt(animOperationGain)}</span>
          </div>
          <div className="border-t pt-3 mt-3">
            <div className="flex justify-between items-baseline">
              <span className="text-lg font-semibold text-success">合計</span>
              <span className="text-4xl md:text-5xl font-mono font-bold text-success">
                {fmt(animTotalGain)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Pain ── */}
      <Card className="border-destructive/30 bg-destructive/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-destructive text-lg">
            <AlertTriangle className="h-5 w-5" />
            Pain: 法令違反リスク（月額）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between text-base">
            <span className="text-muted-foreground">遅延利息（年率14.6%・支払が1か月遅れた場合）</span>
            <span className="font-mono font-semibold text-destructive">{fmt(animLatePayment)}</span>
          </div>
          {isGmenWarning && (
            <Badge variant="destructive" className="animate-pulse text-sm py-1.5 px-3">
              🔴 トラックGメン監視対象（待機{waitingMin}分）
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* ── 免責事項 ── */}
      <p className="text-xs text-muted-foreground text-center px-4">
        ※算出額は国交省の標準的運賃や取適法（年率14.6%）等の基準に基づくシミュレーションであり、実際の金額を保証するものではありません
      </p>
    </div>
  );
}
