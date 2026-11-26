// Design system barrel. See README.md in this folder for props and usage.

export { AlertToggle, alertsEnabledMessage, useAlertToggle, type AlertToggleProps } from './AlertToggle';
export { AppShell, LiveIndicator, TestModeIndicator } from './AppShell';
export { Badge, type BadgeProps } from './Badge';
export { Button, buttonClass, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { Card, type CardProps } from './Card';
export { ChatLog, countNewMessages, type ChatLogProps } from './ChatLog';
export {
  ALERT_KINDS,
  ALERT_LABEL,
  alertParts,
  alertSummary,
  chatSegments,
  formatAlertAmount,
  formatMoney,
  formatTier,
  isAlertKind,
  messageAlert,
  safeImageUrl,
  type ChatSegment,
} from './chat-format';
export { ConfirmButton, type ConfirmButtonProps } from './ConfirmButton';
export { CopyField, type CopyFieldProps } from './CopyField';
export { DynamicForm, type DynamicFormProps } from './DynamicForm';
export {
  addLinkRow,
  cleanLinks,
  cleanValues,
  coerceNumber,
  destinationFormValues,
  destinationSecretsSet,
  initialValues,
  isBlankLink,
  isHttpUrl,
  isValidUrl,
  LINK_URL_MAX,
  linkRowErrors,
  moveLinkRow,
  removeLinkRow,
  splitDestinationValues,
  toLinkItems,
  updateLinkRow,
  validateLinks,
  validateValues,
  type FormErrors,
  type FormValues,
  type LinkRowErrors,
} from './dynamic-form';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorBoundary } from './ErrorBoundary';
export { Field, useFieldControl, type FieldProps } from './Field';
export * from './format';
export * from './icons';
export { LinksEditor, type LinksEditorProps } from './LinksEditor';
export { Modal, type ModalProps } from './Modal';
export { PHASE_META, PhaseBadge, phaseMeta, type PhaseBadgeProps } from './PhaseBadge';
export { PairingBanner } from './PairingBanner';
export { ScopeUpgradeBanner } from './ScopeUpgradeBanner';
export { PLATFORM_META, PlatformBadge, platformMeta, platformName, type PlatformBadgeProps } from './PlatformBadge';
export { PROFILE_STATUS_UI, ProfileDot, ProfileStatusBadge, ProfileTag } from './ProfileBadge';
export { LiveProfilesIndicator, ProfileSwitcher, ProfileSwitcherView, type ProfileSwitcherViewProps } from './ProfileSwitcher';
export { Select, type SelectOption, type SelectProps } from './Select';
export { Spinner, type SpinnerProps } from './Spinner';
export { StatusDot, type StatusDotProps } from './StatusDot';
export { panelId, TabPanel, tabId, Tabs, type TabItem, type TabsProps } from './Tabs';
export { TextInput, type TextInputProps } from './TextInput';
export { dismissToast, toast, ToastProvider } from './Toast';
export { Toggle, type ToggleProps } from './Toggle';
export { copyText, cx, safeHexColor, safeHttpUrl, type Tone } from './utils';
