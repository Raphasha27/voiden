import { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { SearchResult } from "@/types";
import { useDebounce } from "./useDebounce";
import { getParentPath } from "./treeData";

interface UseFullTextSearchArgs {
  storeIsSearching: boolean;
  openSearchTick: number;
  activeFileSource: string | undefined;
  activeDirectory: string | undefined;
}

export function useFullTextSearch({
  storeIsSearching,
  openSearchTick,
  activeFileSource,
  activeDirectory,
}: UseFullTextSearchArgs) {
  const [rawQuery, setRawQuery] = useState<string>("");
  const searchQuery = useDebounce(rawQuery, 300);
  const [matchCase, setMatchCase] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [useMultiline, setUseMultiline] = useState(false);
  const [fileMaskEnabled, setFileMaskEnabled] = useState(false);
  const [fileMask, setFileMask] = useState("*.void");
  const [dirMaskEnabled, setDirMaskEnabled] = useState(false);
  const [dirMask, setDirMask] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);

  const dirMaskUserEditedRef = useRef(false);
  const findInputRef = useRef<HTMLTextAreaElement>(null);

  // Debounce mask inputs so each keystroke doesn't kick off a new rg run.
  const debouncedFileMask = useDebounce(fileMask, 300);
  const debouncedDirMask = useDebounce(dirMask, 300);

  const [childDirs, setChildDirs] = useState<string[]>([]);
  const lastFetchedKeyRef = useRef<string | undefined>(undefined);

  const parentPrefix = useMemo(() => {
    const lastSlash = dirMask.lastIndexOf("/");
    return lastSlash >= 0 ? dirMask.slice(0, lastSlash + 1) : "";
  }, [dirMask]);

  const dirSuggestions = useMemo(() => {
    const partial = dirMask.slice(parentPrefix.length).toLowerCase();
    return childDirs.filter((d) => {
      const rest = d.slice(parentPrefix.length);
      if (!includeHidden && rest.startsWith(".")) return false;
      if (partial && !rest.toLowerCase().startsWith(partial)) return false;
      return true;
    }).slice(0, 10);
  }, [childDirs, dirMask, parentPrefix, includeHidden]);

  useEffect(() => {
    if (rawQuery.includes("\n")) setUseMultiline(true);
  }, [rawQuery]);

  useHotkeys(
    ["alt+f", "alt+d", "alt+."],
    (_e, handler) => {
      switch (handler.hotkey) {
        case "alt+f": setFileMaskEnabled((v) => !v); break;
        case "alt+d": setDirMaskEnabled((v) => !v); break;
        case "alt+.": setIncludeHidden((v) => !v); break;
      }
    },
    { enabled: storeIsSearching, enableOnFormTags: ["INPUT", "TEXTAREA"], preventDefault: true },
    [storeIsSearching],
  );

  useEffect(() => {
    if (!storeIsSearching) return;
    const key = `${activeDirectory ?? ""}::${parentPrefix}`;
    if (lastFetchedKeyRef.current === key) return;
    lastFetchedKeyRef.current = key;
    const parent = parentPrefix.replace(/\/+$/, "");
    window.electron?.listDirs?.(parent || undefined)
      .then((dirs) => setChildDirs(dirs ?? []))
      .catch(() => {});
  }, [storeIsSearching, activeDirectory, parentPrefix]);

  useEffect(() => {
    if (storeIsSearching) {
      setTimeout(() => findInputRef.current?.focus(), 0);
    }
  }, [openSearchTick, storeIsSearching]);

  useEffect(() => {
    if (!storeIsSearching || dirMaskUserEditedRef.current) return;
    const projectRoot = activeDirectory ?? "";
    const fileParent = activeFileSource ? getParentPath(activeFileSource) : "";
    if (projectRoot && fileParent.startsWith(projectRoot)) {
      const rel = fileParent.slice(projectRoot.length).replace(/^[/\\]/, "");
      if (rel) setDirMask(rel);
    }
  }, [storeIsSearching, activeFileSource, activeDirectory]);

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchIdRef = useRef(0);
  const seenSearchResultsRef = useRef(new Set<string>());

  useEffect(() => {
    window.electron?.cancelSearch?.(searchIdRef.current);

    if (!searchQuery) {
      setSearchResults([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    searchIdRef.current += 1;
    const currentId = searchIdRef.current;

    seenSearchResultsRef.current = new Set();
    setSearchResults([]);
    setIsSearching(true);
    setSearchError(null);

    window.electron?.startSearch?.({
      query: searchQuery, matchCase, matchWholeWord, useRegex, useMultiline, searchId: currentId,
      fileMask: fileMaskEnabled ? debouncedFileMask.trim() || undefined : undefined,
      dirMask: dirMaskEnabled ? debouncedDirMask.trim() || undefined : undefined,
      includeHidden,
    });

    let firstResult = true;
    const unsubResult = window.electron?.onSearchResult?.((data) => {
      if (data.searchId !== currentId) return;
      const key = `${data.result.path}:${data.result.line}:${data.result.col}`;
      if (!seenSearchResultsRef.current.has(key)) {
        seenSearchResultsRef.current.add(key);
        if (firstResult) {
          firstResult = false;
          setSearchResults([data.result]);
        } else {
          setSearchResults((prev) => [...prev, data.result]);
        }
      }
    });

    const unsubDone = window.electron?.onSearchDone?.((data) => {
      if (data.searchId !== currentId) return;
      setIsSearching(false);
      if (data.error) setSearchError(data.error);
      if (firstResult) setSearchResults([]);
    });

    return () => {
      unsubResult?.();
      unsubDone?.();
      window.electron?.cancelSearch?.(currentId);
    };
  }, [searchQuery, matchCase, matchWholeWord, useRegex, useMultiline, fileMaskEnabled, debouncedFileMask, dirMaskEnabled, debouncedDirMask, includeHidden]);

  const resetSearch = () => {
    setRawQuery("");
    dirMaskUserEditedRef.current = false;
  };

  return {
    // query
    rawQuery, setRawQuery, searchQuery,
    // toggles
    matchCase, setMatchCase, matchWholeWord, setMatchWholeWord,
    useRegex, setUseRegex, useMultiline, setUseMultiline,
    // masks
    fileMaskEnabled, setFileMaskEnabled, fileMask, setFileMask,
    dirMaskEnabled, setDirMaskEnabled, dirMask, setDirMask,
    includeHidden, setIncludeHidden,
    // suggestions
    dirSuggestions,
    // refs
    findInputRef,
    dirMaskUserEditedRef,
    // results
    searchResults, isSearching, searchError,
    // helpers
    resetSearch,
  };
}

export type FullTextSearch = ReturnType<typeof useFullTextSearch>;
