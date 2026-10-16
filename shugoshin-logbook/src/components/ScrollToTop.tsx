import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * ページ（パス）が変わったら先頭に戻す。
 * SPA では前のページのスクロール位置が残るため、下のタブで報告書などに移ると途中から表示されてしまう。
 * 戻る・進む（POP）はブラウザの位置復元に任せる。
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === "POP") return;
    window.scrollTo(0, 0);
  }, [pathname, navigationType]);

  return null;
}
