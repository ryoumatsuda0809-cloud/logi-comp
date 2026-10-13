import { useCallback, useEffect, useState } from "react";
import { Loader2, LocateFixed, MapPin, Plus, ShieldAlert } from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { toDisplayMessage } from "@/lib/dbErrors";
import {
  describeGeolocationError,
  FACILITY_ADDRESS_MAX,
  FACILITY_CLIENT_NAME_MAX,
  FACILITY_NAME_MAX,
  FACILITY_RADIUS_M,
  GEOLOCATION_UNSUPPORTED_MESSAGE,
  MAX_UNVERIFIED_FACILITIES,
  registrationBlockReason,
  unverifiedQuota,
  validateFacilityForm,
  verificationLabel,
  type RegistrationPosition,
} from "@/lib/facilityRegistration";
import { PageHeader } from "@/components/PageHeader";
import { BottomNav } from "@/components/BottomNav";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldButton } from "@/components/ui/field-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface RegisteredFacility {
  id: string;
  name: string;
  client_name: string;
  address: string | null;
  verification_status: string;
  created_at: string;
}

/**
 * 施設の登録（管理者向け）
 *
 * 【設計】誰でも好きな座標に施設を作れると、GPS の証拠の意味がなくなる
 * （自分の居場所に施設を作れば、いつでも500m圏内になれる）。そのため、
 * - 位置は、管理者が「いま立っている場所」の現在地だけで決める（地図で選ばせない）
 * - 登録した施設は「未確認」。登録した組織のメンバーだけが打刻に使える
 * - 「確認済み」にするのは運営者（この画面からはできない）
 */
export default function FacilityRegistration() {
  const { toast } = useToast();
  const { orgId, loading: orgLoading } = useOrganization();

  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [address, setAddress] = useState("");
  const [notificationNumber, setNotificationNumber] = useState("");
  const [position, setPosition] = useState<RegistrationPosition | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(
    typeof navigator !== "undefined" && !navigator.geolocation ? GEOLOCATION_UNSUPPORTED_MESSAGE : null,
  );
  const [submitting, setSubmitting] = useState(false);

  const [facilities, setFacilities] = useState<RegisteredFacility[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);

  const fetchFacilities = useCallback(async () => {
    if (!orgId) {
      setFacilities([]);
      setListLoading(false);
      return;
    }
    setListLoading(true);
    setListError(false);
    const { data, error } = await supabase
      .from("facilities")
      .select("id, name, client_name, address, verification_status, created_at")
      .eq("registered_by_organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error || !data) {
      // 取得に失敗した場合を「0件」と表示しない（上限の判断を誤らせる）
      setFacilities([]);
      setListError(true);
    } else {
      setFacilities(data);
    }
    setListLoading(false);
  }, [orgId]);

  useEffect(() => {
    if (!orgLoading) void fetchFacilities();
  }, [orgLoading, fetchFacilities]);

  const unverifiedCount = facilities.filter((f) => f.verification_status === "unverified").length;
  const quota = unverifiedQuota(unverifiedCount);
  // 一覧が読めていないときは上限を判断できないので、登録は一覧が読めてから
  const canJudgeQuota = !listLoading && !listError;

  const result = validateFacilityForm({ name, clientName, address, notificationNumber, position });
  const blockReason =
    geoError && !position
      ? geoError
      : registrationBlockReason(result, quota.full) ??
        (!canJudgeQuota ? "登録済みの施設を読み込めていません。再読み込みしてください。" : null);

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setGeoError(GEOLOCATION_UNSUPPORTED_MESSAGE);
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        });
        setLocating(false);
      },
      (err) => {
        setPosition(null);
        setGeoError(describeGeolocationError(err.code));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  };

  const handleSubmit = async () => {
    if (!result.ok || !result.values || blockReason) return;
    const v = result.values;
    setSubmitting(true);
    const { error } = await supabase.rpc("register_facility", {
      p_name: v.name,
      p_client_name: v.clientName,
      p_lat: v.lat,
      p_lng: v.lng,
      p_address: v.address,
      p_notification_number: v.notificationNumber,
    });
    setSubmitting(false);

    if (error) {
      toast({
        variant: "destructive",
        title: "施設を登録できませんでした",
        description: toDisplayMessage(error, "通信状況を確認して、もう一度お試しください。"),
      });
      return;
    }

    toast({
      title: "施設を登録しました",
      description: "未確認の施設として登録しました。この組織のドライバーが打刻に使えます。",
    });
    // 次の施設は、その場所で改めて現在地を取る
    setName("");
    setClientName("");
    setAddress("");
    setNotificationNumber("");
    setPosition(null);
    void fetchFacilities();
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <PageHeader title="施設の登録" subtitle="荷主の現場を追加" backTo="/" />

      <main className="mx-auto max-w-3xl space-y-4 p-4">
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>登録した施設は「未確認」になります</AlertTitle>
          <AlertDescription className="text-xs leading-relaxed">
            位置は、いまいる場所の現在地で記録します（地図では選べません）。登録した施設は、
            <strong>この組織のメンバーだけ</strong>が打刻に使えます。他の組織からは見えません。
            運営者が荷主と場所を確認すると「確認済み」になります。
            未確認の施設は組織ごとに最大{MAX_UNVERIFIED_FACILITIES}件までです。
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <Plus className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">新しい施設を登録する</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="facility-name" className="text-base font-semibold">
                施設名 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="facility-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={FACILITY_NAME_MAX + 20}
                placeholder="例: 第二物流センター"
                className="h-12 text-base"
              />
              {name.trim().length > 0 && result.errors.name && (
                <p className="text-xs text-destructive">{result.errors.name}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="facility-client" className="text-base font-semibold">
                荷主名 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="facility-client"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                maxLength={FACILITY_CLIENT_NAME_MAX + 20}
                placeholder="例: 株式会社サンプル"
                className="h-12 text-base"
              />
              {clientName.trim().length > 0 && result.errors.clientName && (
                <p className="text-xs text-destructive">{result.errors.clientName}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="facility-address" className="text-base font-semibold">
                住所（任意）
              </Label>
              <Input
                id="facility-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                maxLength={FACILITY_ADDRESS_MAX + 20}
                placeholder="例: 東京都江東区…"
                className="h-12 text-base"
              />
              {result.errors.address && <p className="text-xs text-destructive">{result.errors.address}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="facility-notification" className="text-base font-semibold">
                届出番号（任意・7桁）
              </Label>
              <Input
                id="facility-notification"
                value={notificationNumber}
                onChange={(e) => setNotificationNumber(e.target.value)}
                inputMode="numeric"
                placeholder="水産物を扱う荷主のみ"
                className="h-12 text-base"
              />
              {notificationNumber.trim().length > 0 && result.errors.notificationNumber && (
                <p className="text-xs text-destructive">{result.errors.notificationNumber}</p>
              )}
              <p className="text-xs text-muted-foreground">
                漁獲番号の先頭7桁に使われます。確かな番号が分からないときは空欄にしてください。
              </p>
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-base font-semibold">施設の位置</p>
              {position ? (
                <p className="flex items-start gap-2 text-sm">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>
                    <span className="font-mono">
                      {position.lat.toFixed(6)}, {position.lng.toFixed(6)}
                    </span>
                    {position.accuracyM !== null && (
                      <span className="text-muted-foreground">（誤差 約{Math.round(position.accuracyM)}m）</span>
                    )}
                    <br />
                    <span className="text-xs text-muted-foreground">
                      この地点から半径{FACILITY_RADIUS_M}m以内で打刻できる施設になります。
                    </span>
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  施設の敷地の中（入口付近）に立って、現在地を取得してください。
                </p>
              )}
              {geoError && <p className="text-sm text-destructive">{geoError}</p>}
              {position && result.errors.position && (
                <p className="text-sm text-destructive">{result.errors.position}</p>
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleLocate}
                disabled={locating || submitting}
              >
                {locating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <LocateFixed className="mr-2 h-4 w-4" />
                )}
                {locating ? "現在地を取得中..." : position ? "現在地を取得し直す" : "現在地を取得する"}
              </Button>
            </div>

            <FieldButton
              variant="accent"
              size="lg"
              onClick={handleSubmit}
              disabled={submitting || blockReason !== null}
            >
              {submitting ? <Loader2 className="animate-spin" /> : <Plus />}
              {submitting ? "登録中..." : "未確認の施設として登録する"}
            </FieldButton>
            {blockReason && !submitting && (
              <p className="text-center text-sm text-muted-foreground" role="status">
                {blockReason}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <MapPin className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">この組織が登録した施設</CardTitle>
            {canJudgeQuota && (
              <span className="ml-auto text-sm text-muted-foreground">
                未確認 {unverifiedCount} / {MAX_UNVERIFIED_FACILITIES}件
              </span>
            )}
          </CardHeader>
          <CardContent>
            {(listLoading || orgLoading) && (
              <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                読み込み中...
              </div>
            )}
            {!listLoading && !orgLoading && !orgId && (
              <p className="p-4 text-center text-sm text-muted-foreground">
                組織に所属していないため、施設を登録できません。
              </p>
            )}
            {!listLoading && listError && (
              <div className="p-4 text-center text-sm">
                <p className="font-medium text-destructive">登録済みの施設を読み込めませんでした。</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={fetchFacilities}>
                  再読み込み
                </Button>
              </div>
            )}
            {!listLoading && !listError && orgId && facilities.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">まだ登録した施設はありません。</p>
            )}
            {!listLoading && !listError && facilities.length > 0 && (
              <ul className="divide-y">
                {facilities.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{f.name}</p>
                      <p className="truncate text-sm text-muted-foreground">{f.client_name}</p>
                      {f.address && <p className="truncate text-xs text-muted-foreground">{f.address}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">
                        登録 {format(new Date(f.created_at), "yyyy年M月d日", { locale: ja })}
                      </p>
                    </div>
                    <Badge variant={f.verification_status === "verified" ? "default" : "outline"} className="shrink-0">
                      {verificationLabel(f.verification_status)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>

      <BottomNav />
    </div>
  );
}
