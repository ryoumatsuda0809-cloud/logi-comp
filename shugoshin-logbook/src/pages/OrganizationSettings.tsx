import { toDisplayMessage } from "@/lib/dbErrors";
import { useState, useEffect, useRef, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useNavigate } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { FieldButton } from "@/components/ui/field-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Shield,
  ArrowLeft,
  Building2,
  Users,
  AlertTriangle,
  CheckCircle2,
  UserPlus,
  Save,
  MapPin,
  Search,
  Phone,
  Copy,
  KeyRound,
  Plus,
  XCircle,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

type Organization = {
  id: string;
  name: string;
};

type OrgDetails = {
  id: string;
  organization_id: string;
  postal_code: string | null;
  prefecture: string | null;
  city: string | null;
  address_line1: string | null;
  address_line2: string | null;
  phone_number: string | null;
};

type OrgFinancials = {
  id: string;
  employee_count: number | null;
  capital_amount: number | null;
  is_regulated: boolean | null;
};

type Member = {
  id: string;
  user_id: string | null;
  role: string | null;
  created_at: string | null;
  display_name: string | null;
};

type InviteCode = {
  id: string;
  code: string;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
};

const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  dispatcher: "配車担当",
  driver: "ドライバー",
  user: "一般ユーザー",
};

function roleBadgeVariant(role: string | null): "destructive" | "default" | "secondary" | "outline" {
  if (role === "admin") return "destructive";
  if (role === "dispatcher") return "default";
  return "secondary";
}

function parseAddress(fullAddress: string): { prefecture: string; city: string; addressLine1: string } {
  if (!fullAddress) return { prefecture: "", city: "", addressLine1: "" };
  const prefMatch = fullAddress.match(/^(北海道|東京都|京都府|大阪府|.{2,3}県)/);
  const pref = prefMatch ? prefMatch[1] : "";
  const rest = pref ? fullAddress.slice(pref.length) : fullAddress;
  const cityMatch = rest.match(/^(.+?[市区町村])/);
  const cityPart = cityMatch ? cityMatch[1] : rest;
  const addressPart = cityMatch ? rest.slice(cityPart.length) : "";
  return { prefecture: pref, city: cityPart, addressLine1: addressPart };
}

export default function OrganizationSettings() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [org, setOrg] = useState<Organization | null>(null);
  const [orgFinancials, setOrgFinancials] = useState<OrgFinancials | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fetchingAddress, setFetchingAddress] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joiningByCode, setJoiningByCode] = useState(false);

  // Stealth suggest (verify_company_name)
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [newOrgVerifiedName, setNewOrgVerifiedName] = useState<string | null>(null);
  const [isNewOrgVerifying, setIsNewOrgVerifying] = useState(false);
  const verifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newOrgVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const verifyCompanyName = useCallback(async (
    input: string,
    setVerified: (name: string | null) => void,
    setLoading: (v: boolean) => void,
    setInputValue?: (v: string) => void,
    onAddressFound?: (address: string) => void,
  ) => {
    if (input.trim().length < 2) {
      setVerified(null);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("verify_company_name", { _input: input.trim() });
      if (error) {
        console.error("[verify_company_name] error:", error);
        setVerified(null);
        return;
      }
      if (data && data.length === 1) {
        const matched = data[0].matched_client_name;
        const address = data[0].matched_address;
        setVerified(matched);
        if (setInputValue && matched) {
          setInputValue(matched);
        }
        if (onAddressFound && address) {
          onAddressFound(address);
        }
      } else {
        setVerified(null);
      }
    } catch (e) {
      console.error("[verify_company_name] exception:", e);
      setVerified(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Multi invite codes
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [creatingCode, setCreatingCode] = useState(false);
  const [deactivatingCodeId, setDeactivatingCodeId] = useState<string | null>(null);

  // Section A: 基本情報
  const [orgName, setOrgName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");

  // Section B: 所在地
  const [postalCode, setPostalCode] = useState("");
  const [prefecture, setPrefecture] = useState("");
  const [city, setCity] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");

  // Section C: 財務情報
  const [employeeCount, setEmployeeCount] = useState("");
  const [capitalAmount, setCapitalAmount] = useState("");

  // Debounce: orgName → verify_company_name
  useEffect(() => {
    setVerifiedName(null);
    if (orgName.trim().length < 2) return;
    if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = setTimeout(() => {
      verifyCompanyName(orgName, setVerifiedName, setIsVerifying, setOrgName, (addr) => {
        const parsed = parseAddress(addr);
        setPrefecture(parsed.prefecture);
        setCity(parsed.city);
        setAddressLine1(parsed.addressLine1);
      });
    }, 800);
    return () => { if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current); };
  }, [orgName, verifyCompanyName]);

  // Debounce: newOrgName → verify_company_name
  useEffect(() => {
    setNewOrgVerifiedName(null);
    if (newOrgName.trim().length < 2) return;
    if (newOrgVerifyTimerRef.current) clearTimeout(newOrgVerifyTimerRef.current);
    newOrgVerifyTimerRef.current = setTimeout(() => {
      verifyCompanyName(newOrgName, setNewOrgVerifiedName, setIsNewOrgVerifying, setNewOrgName);
    }, 800);
    return () => { if (newOrgVerifyTimerRef.current) clearTimeout(newOrgVerifyTimerRef.current); };
  }, [newOrgName, verifyCompanyName]);

  useEffect(() => {
    if (!user) return;
    fetchData();
  }, [user]);

  async function fetchData() {
    setLoading(true);
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("user_id", user!.id)
        .single();

      if (!profile?.organization_id) {
        setLoading(false);
        return;
      }

      const orgId = profile.organization_id;

      const [orgResult, detailsResult, financialsResult, membersResult, codesResult] = await Promise.all([
        supabase
          .from("organizations")
          .select("id, name")
          .eq("id", orgId)
          .single(),
        supabase
          .from("organization_details")
          .select("id, organization_id, phone_number, postal_code, prefecture, city, address_line1, address_line2")
          .eq("organization_id", orgId)
          .maybeSingle(),
        supabase
          .from("organization_financials")
          .select("id, capital_amount, employee_count, is_regulated")
          .eq("organization_id", orgId)
          .maybeSingle(),
        supabase
          .from("organization_members")
          .select("id, user_id, role, created_at")
          .eq("organization_id", orgId),
        supabase
          .from("organization_invite_codes")
          .select("id, code, is_active, created_at, expires_at, max_uses, use_count")
          .eq("organization_id", orgId)
          .eq("is_active", true)
          .order("created_at", { ascending: false }),
      ]);

      if (orgResult.data) {
        const o = orgResult.data as unknown as Organization;
        setOrg(o);
        setOrgName(o.name);
      }

      if (detailsResult.data) {
        const d = detailsResult.data as OrgDetails;
        setPhoneNumber(d.phone_number ?? "");
        setPostalCode(d.postal_code ?? "");
        setPrefecture(d.prefecture ?? "");
        setCity(d.city ?? "");
        setAddressLine1(d.address_line1 ?? "");
        setAddressLine2(d.address_line2 ?? "");
      }

      if (financialsResult.data) {
        setOrgFinancials(financialsResult.data);
        setEmployeeCount(financialsResult.data.employee_count != null ? String(financialsResult.data.employee_count) : "");
        setCapitalAmount(financialsResult.data.capital_amount != null ? String(financialsResult.data.capital_amount) : "");
      }

      if (codesResult.data) {
        setInviteCodes(codesResult.data as InviteCode[]);
      }

      if (membersResult.data && membersResult.data.length > 0) {
        const userIds = membersResult.data.map((m) => m.user_id).filter(Boolean) as string[];
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, display_name")
          .in("user_id", userIds);

        const profileMap = new Map(profiles?.map((p) => [p.user_id, p.display_name]) ?? []);

        setMembers(
          membersResult.data.map((m) => ({
            ...m,
            display_name: m.user_id ? (profileMap.get(m.user_id) ?? "未設定") : "未設定",
          }))
        );
      }
    } catch (e) {
      console.error("fetchData error", e);
    } finally {
      setLoading(false);
    }
  }

  // 郵便番号から住所を自動入力（zipcloud API）
  async function fetchAddressByPostalCode(code: string) {
    const cleaned = code.replace(/-/g, "");
    if (cleaned.length !== 7) return;

    setFetchingAddress(true);
    try {
      const res = await fetch(
        `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${cleaned}`
      );
      if (!res.ok) throw new Error("APIエラー");
      const json = await res.json();
      if (json.results && json.results[0]) {
        const r = json.results[0];
        setPrefecture(r.address1);
        setCity(r.address2 + r.address3);
        toast({ title: "住所を自動入力しました", description: `${r.address1}${r.address2}${r.address3}` });
      } else {
        toast({
          title: "郵便番号が見つかりません",
          description: "正しい7桁の郵便番号を入力してください",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "住所検索に失敗しました",
        description: "手動で都道府県・市区町村を入力してください",
        variant: "destructive",
      });
    } finally {
      setFetchingAddress(false);
    }
  }

  function handlePostalCodeChange(value: string) {
    setPostalCode(value);
    const cleaned = value.replace(/-/g, "");
    if (cleaned.length === 7) {
      fetchAddressByPostalCode(cleaned);
    }
  }

  async function handleCreateOrganization() {
    if (!newOrgName.trim()) {
      toast({ title: "組織名を入力してください", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const { error } = await supabase.rpc("create_organization_with_admin", {
        org_name: newOrgName.trim(),
      });
      if (error) throw error;
      toast({
        title: "組織を作成しました",
        description: `「${newOrgName}」の管理者として登録されました。`,
      });
      window.location.reload();
    } catch (e: any) {
      console.error("組織作成失敗:", e);
      toast({
        title: "作成に失敗しました",
        description: toDisplayMessage(e, "不明なエラーが発生しました"),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  async function handleJoinByInviteCode() {
    if (!joinCode.trim()) {
      toast({ title: "招待コードを入力してください", variant: "destructive" });
      return;
    }
    setJoiningByCode(true);
    try {
      const { data, error } = await supabase.rpc("join_organization_by_invite_code", {
        _code: joinCode.trim(),
      });
      if (error) throw error;
      // 無効・期限切れ・使用上限のコードは、失敗の記録を残すため例外ではなく NULL で返る
      if (!data) {
        throw new Error("招待コードが見つからないか、有効期限が切れています。管理者に確認してください。");
      }
      toast({
        title: "組織に参加しました",
        description: "ドライバーとして登録されました。",
      });
      window.location.reload();
    } catch (e: any) {
      toast({
        title: "参加に失敗しました",
        description: toDisplayMessage(e, "招待コードを確認してください"),
        variant: "destructive",
      });
    } finally {
      setJoiningByCode(false);
    }
  }

  async function handleCreateInviteCode() {
    if (!org) return;
    setCreatingCode(true);
    try {
      const { data, error } = await supabase.rpc("create_invite_code", {
        _org_id: org.id,
      });
      if (error) throw error;
      // Refetch codes to get the full record with id
      const { data: codes } = await supabase
        .from("organization_invite_codes")
        .select("id, code, is_active, created_at, expires_at, max_uses, use_count")
        .eq("organization_id", org.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (codes) setInviteCodes(codes as InviteCode[]);
      toast({ title: "新しい招待コードを発行しました", description: `コード: ${data}` });
    } catch (e: any) {
      toast({
        title: "発行に失敗しました",
        description: toDisplayMessage(e),
        variant: "destructive",
      });
    } finally {
      setCreatingCode(false);
    }
  }

  async function handleDeactivateCode(codeId: string, codeText: string) {
    setDeactivatingCodeId(codeId);
    try {
      const { error } = await supabase.rpc("deactivate_invite_code", {
        _code_id: codeId,
      });
      if (error) throw error;
      setInviteCodes((prev) => prev.filter((c) => c.id !== codeId));
      toast({ title: "招待コードを無効化しました", description: `コード: ${codeText}` });
    } catch (e: any) {
      toast({
        title: "無効化に失敗しました",
        description: toDisplayMessage(e),
        variant: "destructive",
      });
    } finally {
      setDeactivatingCodeId(null);
    }
  }

  async function handleSave() {
    if (!org) return;
    setSaving(true);
    try {
      const [orgUpdate, detailsUpsert, financialsUpsert] = await Promise.all([
        supabase
          .from("organizations")
          .update({ name: orgName })
          .eq("id", org.id),
        supabase
          .from("organization_details")
          .upsert(
            {
              organization_id: org.id,
              phone_number: phoneNumber || null,
              postal_code: postalCode || null,
              prefecture: prefecture || null,
              city: city || null,
              address_line1: addressLine1 || null,
              address_line2: addressLine2 || null,
            },
            { onConflict: "organization_id" }
          ),
        supabase
          .from("organization_financials")
          .upsert(
            {
              organization_id: org.id,
              employee_count: parseInt(employeeCount) || 0,
              capital_amount: parseInt(capitalAmount) || 0,
              is_regulated: isRegulated,
            },
            { onConflict: "organization_id" }
          ),
      ]);

      if (orgUpdate.error) throw orgUpdate.error;
      if (detailsUpsert.error) throw detailsUpsert.error;
      if (financialsUpsert.error) throw financialsUpsert.error;

      setOrg((prev) =>
        prev ? { ...prev, name: orgName } : prev
      );
      setOrgFinancials((prev) =>
        prev
          ? {
              ...prev,
              employee_count: parseInt(employeeCount) || 0,
              capital_amount: parseInt(capitalAmount) || 0,
              is_regulated: isRegulated,
            }
          : {
              id: "",
              employee_count: parseInt(employeeCount) || 0,
              capital_amount: parseInt(capitalAmount) || 0,
              is_regulated: isRegulated,
            }
      );

      toast({ title: "保存しました", description: "組織情報を更新しました。" });
    } catch (e: any) {
      toast({ title: "保存失敗", description: toDisplayMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // 特定荷主判定
  const empCount = parseInt(employeeCount) || 0;
  const capAmount = parseInt(capitalAmount) || 0;
  const isRegulated = empCount > 300 || capAmount > 300_000_000;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-primary">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <img src="/icon-192.png" alt="守護神" className="h-12 w-12 rounded-lg" />
          <p className="text-primary-foreground/80">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-primary px-4 py-4 shadow-lg">
          <div className="mx-auto flex max-w-lg items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
              <img src="/icon-192.png" alt="守護神" className="h-5 w-5 rounded-md" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-primary-foreground">守護神</h1>
              <p className="text-xs text-primary-foreground/60">はじめての設定</p>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-lg p-4 pt-8">
          <Tabs defaultValue="join" className="w-full">
            <TabsList className="grid w-full grid-cols-2 h-14 text-base">
              <TabsTrigger value="join" className="text-base py-3">
                🔑 招待コードで参加
              </TabsTrigger>
              <TabsTrigger value="create" className="text-base py-3">
                🏢 新規に組織を作成
              </TabsTrigger>
            </TabsList>

            <TabsContent value="join">
              <Card>
                <CardHeader className="flex flex-row items-center gap-3 pb-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                    <KeyRound className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">招待コードで会社に参加する</CardTitle>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      管理者から受け取った6桁のコードを入力してください。
                    </p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="invite-code-input" className="text-base font-semibold">
                      招待コード
                    </Label>
                    <Input
                      id="invite-code-input"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && handleJoinByInviteCode()}
                      className="h-14 text-center text-2xl font-mono tracking-[0.3em] uppercase"
                      placeholder="ABCD1234"
                      maxLength={8}
                      autoFocus
                    />
                  </div>

                  <FieldButton
                    size="lg"
                    onClick={handleJoinByInviteCode}
                    disabled={joiningByCode || joinCode.trim().length < 4}
                  >
                    <UserPlus className="h-6 w-6" />
                    {joiningByCode ? "参加中..." : "この会社に参加する"}
                  </FieldButton>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="create">
              <Card>
                <CardHeader className="flex flex-row items-center gap-3 pb-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                    <Building2 className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">組織を作成する</CardTitle>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      守護神をご利用いただくには、まず組織を作成してください。
                    </p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="new-org-name" className="text-base font-semibold">
                      組織名（会社名・事業所名）
                    </Label>
                    <Input
                      id="new-org-name"
                      value={newOrgName}
                      onChange={(e) => setNewOrgName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateOrganization()}
                      className="h-14 text-lg"
                      placeholder="例: 下関水産株式会社"
                    />
                    {isNewOrgVerifying && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>照合中...</span>
                      </div>
                    )}
                    {newOrgVerifiedName && !isNewOrgVerifying && (
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>マスターデータから情報を自動入力しました</span>
                      </div>
                    )}
                  </div>

                  <FieldButton
                    variant="accent"
                    size="lg"
                    onClick={handleCreateOrganization}
                    disabled={creating || !newOrgName.trim()}
                  >
                    <Building2 className="h-6 w-6" />
                    {creating ? "作成中..." : "この組織を作成して管理者になる"}
                  </FieldButton>

                  <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                      作成後、あなたはこの組織の<strong className="text-foreground">管理者</strong>として登録されます。
                      他のメンバーは後から招待できます。
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-primary px-4 py-4 shadow-lg">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-primary-foreground/70 hover:bg-primary-foreground/10"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
              <Building2 className="h-5 w-5 text-accent-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-primary-foreground">組織管理</h1>
              <p className="text-xs text-primary-foreground/60">{org.name}</p>
            </div>
          </div>
          {/* 特定荷主バッジ (ヘッダー) */}
          {isRegulated ? (
            <Badge variant="destructive" className="ml-auto flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              特定荷主
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-auto flex items-center gap-1 border-primary/40 text-primary">
              <CheckCircle2 className="h-3 w-3" />
              規制対象外
            </Badge>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 p-4 pb-24">

        {/* Section A: 基本情報 */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <Building2 className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">基本情報</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org-name" className="text-base font-semibold">
                組織名
              </Label>
              <Input
                id="org-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                className="h-12 text-base"
                placeholder="例: 下関水産株式会社"
              />
              {isVerifying && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>照合中...</span>
                </div>
              )}
              {verifiedName && !isVerifying && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>マスターデータから情報を自動入力しました</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone-number" className="text-base font-semibold">
                電話番号
              </Label>
              <div className="flex items-center gap-2">
                <Phone className="h-5 w-5 shrink-0 text-muted-foreground" />
                <Input
                  id="phone-number"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className="h-12 text-base"
                  placeholder="例: 083-222-0000"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section B: 所在地 */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <MapPin className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">所在地</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="postal-code" className="text-base font-semibold">
                郵便番号
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="postal-code"
                  value={postalCode}
                  onChange={(e) => handlePostalCodeChange(e.target.value)}
                  className="h-12 text-base"
                  placeholder="例: 750-0001"
                  maxLength={8}
                />
                <button
                  onClick={() => fetchAddressByPostalCode(postalCode)}
                  disabled={fetchingAddress}
                  className="flex h-12 shrink-0 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  <Search className="h-4 w-4" />
                  {fetchingAddress ? "検索中..." : "住所検索"}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                7桁入力で自動検索、または「住所検索」ボタンで補完されます
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="prefecture" className="text-base font-semibold">
                  都道府県
                </Label>
                <Input
                  id="prefecture"
                  value={prefecture}
                  onChange={(e) => setPrefecture(e.target.value)}
                  className="h-12 text-base"
                  placeholder="例: 山口県"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city" className="text-base font-semibold">
                  市区町村
                </Label>
                <Input
                  id="city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="h-12 text-base"
                  placeholder="例: 下関市"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="address-line1" className="text-base font-semibold">
                番地など
              </Label>
              <Input
                id="address-line1"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                className="h-12 text-base"
                placeholder="例: 竹崎町4丁目2番地1号"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="address-line2" className="text-base font-semibold">
                建物名など <span className="text-sm font-normal text-muted-foreground">（任意）</span>
              </Label>
              <Input
                id="address-line2"
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                className="h-12 text-base"
                placeholder="例: 守護神ビル 3F"
              />
            </div>
          </CardContent>
        </Card>

        {/* Section C: 財務情報 */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <Shield className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">財務情報・コンプライアンス</CardTitle>
            {isRegulated ? (
              <Badge variant="destructive" className="ml-auto flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                特定荷主（厳格規制対象）
              </Badge>
            ) : (
              <Badge variant="outline" className="ml-auto flex items-center gap-1 border-primary/40 text-primary">
                <CheckCircle2 className="h-3 w-3" />
                規制対象外
              </Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {!orgFinancials && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-sm text-destructive/80">
                  財務情報の取得に失敗しました。権限を確認するか、新しい値を入力して保存してください。
                </p>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="employee-count" className="text-base font-semibold">
                  従業員数
                  {empCount > 300 && (
                    <span className="ml-2 text-sm font-normal text-destructive">
                      （300人超 → 規制対象）
                    </span>
                  )}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="employee-count"
                    type="number"
                    value={employeeCount}
                    onChange={(e) => setEmployeeCount(e.target.value)}
                    className="h-12 text-base"
                    placeholder="0"
                  />
                  <span className="shrink-0 text-muted-foreground">人</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="capital-amount" className="text-base font-semibold">
                  資本金
                  {capAmount > 300_000_000 && (
                    <span className="ml-2 text-sm font-normal text-destructive">
                      （3億円超 → 規制対象）
                    </span>
                  )}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="capital-amount"
                    type="number"
                    value={capitalAmount}
                    onChange={(e) => setCapitalAmount(e.target.value)}
                    className="h-12 text-base"
                    placeholder="0"
                  />
                  <span className="shrink-0 text-muted-foreground">円</span>
                </div>
              </div>
            </div>

            {isRegulated && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-sm text-destructive/80">
                  <strong>特定荷主に該当します。</strong>
                  2026年物流法改正により、書面交付義務・60日支払いルールなどの厳格な規制が適用されます。
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 保存ボタン */}
        <FieldButton
          variant="accent"
          size="lg"
          onClick={handleSave}
          disabled={saving}
        >
          <Save className="h-6 w-6" />
          {saving ? "保存中..." : "保存する"}
        </FieldButton>

        {/* Section D: メンバー一覧 */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <Users className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">メンバー一覧</CardTitle>
            <span className="ml-auto text-sm text-muted-foreground">{members.length}名</span>
          </CardHeader>
          <CardContent>
            {members.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground">
                メンバーが見つかりません。
                <br />
                <span className="text-sm">
                  ※ RLSポリシーが未適用の場合、ここは常に空になります。
                </span>
              </p>
            ) : (
              <div className="divide-y divide-border">
                {members.map((member) => (
                  <div key={member.id} className="flex items-center gap-3 py-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-bold text-muted-foreground">
                      {(member.display_name ?? "?")[0].toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold text-foreground">
                        {member.display_name ?? "名前未設定"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        参加日:{" "}
                        {member.created_at
                          ? format(new Date(member.created_at), "yyyy年M月d日", { locale: ja })
                          : "不明"}
                      </p>
                    </div>
                    <Badge variant={roleBadgeVariant(member.role)}>
                      {ROLE_LABELS[member.role ?? ""] ?? member.role ?? "未設定"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section E: チームメンバー招待 (マルチコード) */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-3">
            <UserPlus className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">チームメンバー招待</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FieldButton
              variant="outline"
              size="lg"
              onClick={handleCreateInviteCode}
              disabled={creatingCode}
            >
              {creatingCode ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Plus className="h-5 w-5" />
              )}
              {creatingCode ? "発行中..." : "新しい招待コードを発行する"}
            </FieldButton>

            {inviteCodes.length === 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-muted bg-muted/30 p-4">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  招待コードがありません。新しく発行してください。
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-base font-semibold">有効なコード</Label>
                <div className="divide-y divide-border rounded-lg border">
                  {inviteCodes.map((ic) => (
                    <div key={ic.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1">
                        <span className="font-mono text-xl font-bold tracking-[0.3em] text-foreground">
                          {ic.code}
                        </span>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {ic.expires_at
                            ? `有効期限 ${new Date(ic.expires_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`
                            : "有効期限なし"}
                          {ic.max_uses !== null && `　使用 ${ic.use_count}/${ic.max_uses}回`}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(ic.code);
                          toast({ title: "コピーしました", description: `招待コード: ${ic.code}` });
                        }}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-input bg-background text-foreground hover:bg-accent"
                        title="コピー"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button
                            disabled={deactivatingCodeId === ic.id}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-background text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            title="無効化"
                          >
                            {deactivatingCodeId === ic.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <XCircle className="h-4 w-4" />
                            )}
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>招待コードを無効化しますか？</AlertDialogTitle>
                            <AlertDialogDescription>
                              コード「{ic.code}」を無効化すると、このコードでは組織に参加できなくなります。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>キャンセル</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDeactivateCode(ic.id, ic.code)}>
                              無効化する
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-sm text-muted-foreground">
                コードをドライバーに伝えてください。コードを入力するだけで組織に参加できます。
              </p>
            </div>
          </CardContent>
        </Card>
      </main>

      <BottomNav />
    </div>
  );
}
