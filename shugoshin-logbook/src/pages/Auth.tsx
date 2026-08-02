import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { FieldButton } from "@/components/ui/field-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { authErrorMessage, isEmailRateLimitError } from "@/lib/authErrors";


export default function Auth() {
  const { user, loading, signIn, signUp } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [autoLogin, setAutoLogin] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // 利用者側で解決できないエラーは、消えるトーストではなく画面に残す
  const [blockingError, setBlockingError] = useState<string | null>(null);
  const { toast } = useToast();

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-primary">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent">
            <img src="/icon-192.png" alt="守護神" className="h-10 w-10 rounded-lg" />
          </div>
          <h1 className="text-3xl font-bold text-primary-foreground">守護神</h1>
          <p className="text-sm text-primary-foreground/60">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    const { error } = isLogin
      ? await signIn(email, password)
      : await signUp(email, password, displayName);

    if (error) {
      // Supabase のエラーは英語で返るため、そのまま出すと日本語話者に伝わらない。
      // 送信上限のように利用者側で解決できないものは画面上にも残す。
      setBlockingError(isEmailRateLimitError(error.message) ? error.message : null);
      toast({
        title: "エラー",
        description: authErrorMessage(error.message),
        variant: "destructive",
      });
    } else if (!isLogin) {
      setBlockingError(null);
      toast({
        title: "登録完了",
        description: "確認メールをご確認ください。",
      });
    }
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-primary p-4">
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent">
          <img src="/icon-192.png" alt="守護神" className="h-10 w-10 rounded-lg" />
        </div>
        <h1 className="text-3xl font-bold text-primary-foreground">守護神</h1>
        <p className="text-sm text-primary-foreground/70">下関水産物流・法適合管理</p>
      </div>

      <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-2xl">
        <h2 className="mb-6 text-center text-xl font-bold text-card-foreground">
          {isLogin ? "ログイン" : "新規登録"}
        </h2>

        {/* 送信上限は利用者の操作では解消できないため、トーストが消えたあとも
            状況が分かるように画面上に残す。 */}
        {blockingError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm font-bold text-destructive">登録を受け付けられません</p>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              {authErrorMessage(blockingError)}
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-base">
                表示名
              </Label>
              <Input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="山田太郎"
                required={!isLogin}
                className="h-12 text-base"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email" className="text-base">
              メールアドレス
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="taro@example.com"
              required
              className="h-12 text-base"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-base">
              パスワード
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="h-12 text-base"
            />
          </div>

          {isLogin && (
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="autoLogin"
                checked={autoLogin}
                onCheckedChange={(checked) => setAutoLogin(checked === true)}
              />
              <Label htmlFor="autoLogin" className="text-sm font-normal text-muted-foreground cursor-pointer">
                次回から自動ログインする
              </Label>
            </div>
          )}

          <FieldButton type="submit" variant="accent" disabled={submitting} className="mt-4">
            {submitting ? "処理中..." : isLogin ? "ログイン" : "登録"}
          </FieldButton>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => setIsLogin(!isLogin)}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {isLogin ? "アカウントをお持ちでない方はこちら" : "既にアカウントをお持ちの方はこちら"}
          </button>
        </div>
      </div>
    </div>
  );
}
