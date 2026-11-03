import type { ComputerStatus } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

/**
 * How many runs may share this computer at once.
 *
 * One computer is one machine, so several of its bots starting together otherwise all run
 * on it and slow each other down. The default is one at a time; a larger number is a
 * deliberate choice for a machine the owner knows can take it. Leaving the field empty
 * clears the override and returns the computer to the instance default.
 */
export function ComputerMaxRunsRow({
  botId,
  computer,
  onChanged,
}: {
  botId: string;
  computer: ComputerStatus;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [draft, setDraft] = useState(String(computer.maxRunsPerComputer));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A refresh from elsewhere (or another device) is the source of truth for the field.
  useEffect(() => {
    setDraft(String(computer.maxRunsPerComputer));
  }, [computer.maxRunsPerComputer]);

  const parsed = draft.trim() === "" ? null : Number(draft.trim());
  const valid = parsed === null || (Number.isSafeInteger(parsed) && parsed >= 1);
  const dirty = parsed !== computer.maxRunsPerComputer;

  async function save() {
    if (saving || !valid || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await rpc("computer/maxRuns", { botId, maxRunsPerComputer: parsed });
      await onChanged();
    } catch (err) {
      setError(errorText(err, t("Could not save computer settings")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 10,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: tokens.foreground, fontSize: 15 }}>
          {t("Runs at the same time")}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {computer.maxRunsPerComputerOverride
            ? t("How many runs may share this computer.")
            : t("Using the default of {count}.", { count: computer.maxRunsPerComputer })}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
            {error}
          </Text>
        ) : null}
      </View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onEndEditing={() => void save()}
        keyboardType="number-pad"
        editable={!saving}
        accessibilityLabel={t("Runs at the same time")}
        placeholder={String(computer.maxRunsPerComputer)}
        placeholderTextColor={tokens.mutedForeground}
        style={{
          minWidth: 56,
          borderWidth: 1,
          borderColor: valid ? tokens.border : tokens.destructive,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 6,
          textAlign: "center",
          color: tokens.foreground,
        }}
      />
      {dirty ? (
        <Pressable
          accessibilityRole="button"
          disabled={saving || !valid}
          onPress={() => void save()}
          style={{ opacity: saving || !valid ? 0.5 : 1 }}
        >
          <Text style={{ color: tokens.primary, fontSize: 15 }}>
            {saving ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
