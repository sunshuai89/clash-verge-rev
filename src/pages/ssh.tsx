import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import FileDownloadRoundedIcon from '@mui/icons-material/FileDownloadRounded'
import FileUploadRoundedIcon from '@mui/icons-material/FileUploadRounded'
import SubjectRoundedIcon from '@mui/icons-material/SubjectRounded'
import {
  Box,
  FormControlLabel,
  GlobalStyles,
  Modal,
  Typography,
} from '@mui/material'
import { listen } from '@tauri-apps/api/event'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'
import { useInterval, useLockFn } from 'ahooks'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog, BaseEmpty, Switch } from '@/components/base'
import {
  clearSshTunnelLogs,
  deleteSshServer,
  exportSshServers,
  getSshServers,
  getSshTunnelLogs,
  getSshTunnelStats,
  importSshServers,
  restartAllSshTunnels,
  saveSshServer,
  startAllSshTunnels,
  startSshTunnel,
  stopSshTunnel,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import parseTraffic from '@/utils/parse-traffic'

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
  bg: '#f4f4f5',
  card: '#ffffff',
  cardBorder: '#ebebed',
  textPrimary: '#18181b',
  textSecondary: '#52525b',
  textMuted: '#71717a',
  textPlaceholder: '#a1a1aa',
  textDisabled: '#c4c4c8',
  textStopped: '#c8c8cc',
  btnPrimary: '#18181b',
  green: '#1f9d57',
  greenBg: 'rgba(31,157,87,.1)',
  amber: '#c2820a',
  red: '#dc2626',
  redBg: '#fef2f2',
  divider: '#eeeef0',
  metricsBarBg: '#fafafa',
  metricsBarBorder: '#f1f1f2',
  monoStack:
    'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  sansStack:
    '-apple-system, "PingFang SC", "Microsoft YaHei", BlinkMacSystemFont, sans-serif',
} as const

// ─── Utilities ────────────────────────────────────────────────────────────────

function latencyColor(ms: number | null, active: boolean): string {
  if (!active || ms == null) return C.textDisabled
  if (ms < 100) return C.green
  if (ms < 250) return C.amber
  return C.red
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1) return '0'
  const [value, unit] = parseTraffic(bytes)
  return `${value}${unit === 'B' ? 'B' : unit[0]}`
}

// ─── State shapes ─────────────────────────────────────────────────────────────

const emptyStats = (): ISshTunnelStats => ({
  status: { state: 'Stopped' },
  latency_ms: null,
  up: 0,
  down: 0,
})

interface ExtStats {
  upRate: number
  downRate: number
}

const emptyExt = (): ExtStats => ({
  upRate: 0,
  downRate: 0,
})

interface SshForm extends ISshServer {
  authType: 'password' | 'key'
  keyPath: string
}

const emptyForm = (): SshForm => ({
  uid: '',
  name: '',
  host: '',
  port: 22,
  username: 'root',
  password: '',
  local_port: 10880,
  enabled: false,
  authType: 'password',
  keyPath: '',
})

// ─── Micro components ─────────────────────────────────────────────────────────

function ActionBtn({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void
  title?: string
  danger?: boolean
  children: ReactNode
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      title={title}
      sx={{
        width: 30,
        height: 30,
        borderRadius: '7px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: C.textPlaceholder,
        flexShrink: 0,
        transition: 'background .12s, color .12s',
        ...(danger
          ? { '&:hover': { bgcolor: C.redBg, color: C.red } }
          : { '&:hover': { bgcolor: '#f4f4f5', color: C.textSecondary } }),
      }}
    >
      {children}
    </Box>
  )
}

function SshSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Box
      component="button"
      onClick={() => onChange(!checked)}
      sx={{
        width: 42,
        height: 24,
        borderRadius: '999px',
        border: 'none',
        cursor: 'pointer',
        bgcolor: checked ? C.btnPrimary : '#dededf',
        position: 'relative',
        transition: 'background .15s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: '3px',
          width: 18,
          height: 18,
          borderRadius: '50%',
          bgcolor: '#fff',
          transition: 'left .15s',
          left: checked ? 'calc(100% - 21px)' : '3px',
          boxShadow: '0 1px 3px rgba(0,0,0,.2)',
        }}
      />
    </Box>
  )
}

function AddressItem({
  label,
  addr,
  onCopy,
}: {
  label: string
  addr: string
  onCopy: () => void
}) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <Box
        component="span"
        sx={{
          fontSize: 9,
          fontWeight: 600,
          color: C.textPlaceholder,
          fontFamily: C.sansStack,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        {label}
      </Box>
      <Box
        component="span"
        sx={{
          fontSize: '12.5px',
          fontFamily: C.monoStack,
          color: C.textSecondary,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {addr}
      </Box>
      <Box
        component="button"
        onClick={onCopy}
        sx={{
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          color: '#c4c4c8',
          flexShrink: 0,
          transition: 'color .1s',
          '&:hover': { color: C.textPrimary },
        }}
      >
        <ContentCopyRoundedIcon sx={{ fontSize: 12 }} />
      </Box>
    </Box>
  )
}

function MetricCell({
  label,
  flex,
  children,
}: {
  label: string
  flex: number
  children: ReactNode
}) {
  return (
    <Box
      sx={{
        flex,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        py: '9px',
        px: '6px',
        gap: '3px',
        minWidth: 0,
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: '10.5px',
          color: C.textPlaceholder,
          fontWeight: 500,
          lineHeight: 1,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '2px',
        }}
      >
        {children}
      </Box>
    </Box>
  )
}

const MetricDivider = () => (
  <Box
    sx={{
      width: '1px',
      bgcolor: C.divider,
      alignSelf: 'stretch',
      my: '6px',
      flexShrink: 0,
    }}
  />
)

function MetricNum({
  value,
  color,
  mono = true,
}: {
  value: string
  color?: string
  mono?: boolean
}) {
  return (
    <Box
      component="span"
      sx={{
        fontSize: '14px',
        fontWeight: 650,
        color: color ?? C.textPrimary,
        fontFamily: mono ? C.monoStack : C.sansStack,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.2,
      }}
    >
      {value}
    </Box>
  )
}

// ─── Tunnel Card ──────────────────────────────────────────────────────────────

interface TunnelCardProps {
  server: ISshServer
  stats: ISshTunnelStats
  ext: ExtStats
  onToggle: (next: boolean) => void
  onLog: () => void
  onEdit: () => void
  onDelete: () => void
  onCopy: (text: string) => void
}

function TunnelCard({
  server,
  stats,
  ext,
  onToggle,
  onLog,
  onEdit,
  onDelete,
  onCopy,
}: TunnelCardProps) {
  const { t } = useTranslation()
  const state = stats.status.state
  const isRunning = state === 'Running'
  const isActive =
    isRunning || state === 'Connecting' || state === 'Reconnecting'

  const sshAddr = `${server.username}@${server.host}:${server.port}`
  const socks5Addr = `127.0.0.1:${server.local_port}`
  const latColor = latencyColor(stats.latency_ms, isRunning)
  const hasTraffic = stats.up > 0 || stats.down > 0

  return (
    <Box
      sx={{
        bgcolor: C.card,
        border: `1px solid ${C.cardBorder}`,
        borderRadius: '14px',
        boxShadow: '0 1px 2px rgba(0,0,0,.03)',
        overflow: 'hidden',
        transition: 'box-shadow .15s',
        '&:hover': {
          boxShadow: '0 5px 16px rgba(0,0,0,.07)',
        },
      }}
    >
      {/* ── Top: identity + controls ── */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          padding: '18px 20px',
          gap: '16px',
        }}
      >
        {/* Left: name row + address row */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {/* Name row */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              mb: '7px',
            }}
          >
            {/* Animated status dot */}
            <Box
              sx={{ position: 'relative', width: 8, height: 8, flexShrink: 0 }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: isActive ? C.green : C.textStopped,
                  position: 'relative',
                  zIndex: 1,
                }}
              />
              {isActive && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    bgcolor: C.green,
                    animation: 'ssh-pulse 1.8s ease-out infinite',
                  }}
                />
              )}
            </Box>
            {/* Name */}
            <Typography
              noWrap
              title={server.name}
              sx={{
                fontSize: '15.5px',
                fontWeight: 650,
                color: isActive ? C.textPrimary : C.textSecondary,
                letterSpacing: '-.01em',
                lineHeight: 1.3,
                fontFamily: C.sansStack,
              }}
            >
              {server.name}
            </Typography>
            {/* Status badge */}
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                px: '7px',
                py: '2px',
                borderRadius: '5px',
                fontSize: '10.5px',
                fontWeight: 600,
                flexShrink: 0,
                fontFamily: C.sansStack,
                ...(isActive
                  ? { color: C.green, bgcolor: C.greenBg }
                  : { color: C.textPlaceholder, bgcolor: '#f1f1f2' }),
              }}
            >
              {t(`ssh.status.${state.toLowerCase()}` as any)}
            </Box>
          </Box>

          {/* Address row */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <AddressItem
              label="SSH"
              addr={sshAddr}
              onCopy={() => onCopy(sshAddr)}
            />
            <AddressItem
              label="SOCKS5"
              addr={socks5Addr}
              onCopy={() => onCopy(socks5Addr)}
            />
          </Box>
        </Box>

        {/* Right: toggle + divider + actions */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexShrink: 0,
          }}
        >
          <SshSwitch checked={server.enabled} onChange={onToggle} />
          <Box
            sx={{ width: '1px', height: 28, bgcolor: '#e4e4e7', flexShrink: 0 }}
          />
          <ActionBtn onClick={onLog} title={t('ssh.actions.logs')}>
            <SubjectRoundedIcon sx={{ fontSize: 14 }} />
          </ActionBtn>
          <ActionBtn onClick={onEdit} title={t('ssh.actions.edit')}>
            <EditRoundedIcon sx={{ fontSize: 14 }} />
          </ActionBtn>
          <ActionBtn onClick={onDelete} title={t('ssh.actions.delete')} danger>
            <DeleteRoundedIcon sx={{ fontSize: 14 }} />
          </ActionBtn>
        </Box>
      </Box>

      {/* ── Bottom: metrics bar ── */}
      <Box
        sx={{
          display: 'flex',
          bgcolor: C.metricsBarBg,
          borderTop: `1px solid ${C.metricsBarBorder}`,
        }}
      >
        {/* Latency */}
        <MetricCell label={t('ssh.metrics.latency')} flex={1}>
          {isRunning && stats.latency_ms != null ? (
            <>
              <MetricNum value={String(stats.latency_ms)} color={latColor} />
              <Box
                component="span"
                sx={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: C.textPlaceholder,
                  ml: '2px',
                }}
              >
                ms
              </Box>
            </>
          ) : (
            <MetricNum value="—" color={C.textDisabled} />
          )}
        </MetricCell>

        <MetricDivider />

        {/* Real-time rate */}
        <MetricCell label={t('ssh.metrics.rate')} flex={1.3}>
          {isRunning ? (
            <>
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                }}
              >
                <ArrowUpwardRoundedIcon sx={{ fontSize: 10, color: C.green }} />
                <MetricNum
                  value={formatBytes(ext.upRate)}
                  color={C.textPrimary}
                />
              </Box>
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                  ml: '4px',
                }}
              >
                <ArrowDownwardRoundedIcon
                  sx={{ fontSize: 10, color: C.textMuted }}
                />
                <MetricNum
                  value={formatBytes(ext.downRate)}
                  color={C.textPrimary}
                />
              </Box>
            </>
          ) : (
            <MetricNum value="—" color={C.textDisabled} />
          )}
        </MetricCell>

        <MetricDivider />

        {/* Cumulative */}
        <MetricCell label={t('ssh.metrics.cumulative')} flex={1.3}>
          {hasTraffic ? (
            <>
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                }}
              >
                <ArrowUpwardRoundedIcon
                  sx={{
                    fontSize: 10,
                    color: isRunning ? C.green : C.textMuted,
                  }}
                />
                <MetricNum
                  value={formatBytes(stats.up)}
                  color={C.textSecondary}
                />
              </Box>
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                  ml: '4px',
                }}
              >
                <ArrowDownwardRoundedIcon
                  sx={{ fontSize: 10, color: C.textMuted }}
                />
                <MetricNum
                  value={formatBytes(stats.down)}
                  color={C.textSecondary}
                />
              </Box>
            </>
          ) : (
            <MetricNum value="—" color={C.textDisabled} />
          )}
        </MetricCell>
      </Box>
    </Box>
  )
}

// ─── Form sub-components ──────────────────────────────────────────────────────

function FormField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Box>
      <Box
        component="label"
        sx={{
          display: 'block',
          fontSize: '12px',
          fontWeight: 600,
          color: C.textSecondary,
          mb: '7px',
          fontFamily: C.sansStack,
        }}
      >
        {label}
      </Box>
      {children}
    </Box>
  )
}

function FormInput({
  value,
  onChange,
  placeholder,
  type,
  mono,
  style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
  style?: CSSProperties
}) {
  return (
    <Box
      component="input"
      type={type ?? 'text'}
      value={value}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value)
      }
      placeholder={placeholder}
      sx={{
        display: 'block',
        width: '100%',
        fontSize: '13px',
        fontFamily: mono ? C.monoStack : C.sansStack,
        color: C.textPrimary,
        bgcolor: C.card,
        border: `1px solid #e4e4e7`,
        borderRadius: '9px',
        padding: '10px 12px',
        outline: 'none',
        boxSizing: 'border-box',
        fontVariantNumeric: mono ? 'tabular-nums' : undefined,
        transition: 'border-color .12s',
        '&:focus': { borderColor: C.textPrimary },
        '&::placeholder': { color: '#b8b8bc' },
        ...style,
      }}
    />
  )
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        bgcolor: '#f1f1f2',
        borderRadius: '9px',
        padding: '3px',
        gap: '2px',
      }}
    >
      {options.map((opt) => (
        <Box
          key={opt.value}
          component="button"
          onClick={() => onChange(opt.value)}
          sx={{
            border: 'none',
            cursor: 'pointer',
            px: '14px',
            py: '6px',
            borderRadius: '7px',
            fontSize: '13px',
            fontWeight: 550,
            fontFamily: C.sansStack,
            transition: 'all .12s',
            ...(opt.value === value
              ? {
                  bgcolor: C.card,
                  color: C.textPrimary,
                  boxShadow: '0 1px 2px rgba(0,0,0,.08)',
                }
              : { bgcolor: 'transparent', color: C.textMuted }),
          }}
        >
          {opt.label}
        </Box>
      ))}
    </Box>
  )
}

function SecondaryBtn({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      disabled={disabled}
      sx={{
        border: `1px solid #e4e4e7`,
        bgcolor: C.card,
        color: disabled ? C.textDisabled : C.textSecondary,
        cursor: disabled ? 'default' : 'pointer',
        px: '13px',
        py: '8px',
        borderRadius: '9px',
        fontSize: '13px',
        fontWeight: 550,
        fontFamily: C.sansStack,
        flexShrink: 0,
        transition: 'all .12s',
        '&:not(:disabled):hover': {
          bgcolor: '#f4f4f5',
          borderColor: '#d4d4d8',
        },
      }}
    >
      {children}
    </Box>
  )
}

function PrimaryBtn({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        border: 'none',
        bgcolor: C.btnPrimary,
        color: '#fff',
        cursor: 'pointer',
        px: '15px',
        py: '9px',
        borderRadius: '9px',
        fontSize: '13px',
        fontWeight: 600,
        fontFamily: C.sansStack,
        flexShrink: 0,
        transition: 'background .12s',
        '&:hover': { bgcolor: '#000' },
      }}
    >
      {children}
    </Box>
  )
}

// ─── Add / Edit dialog ────────────────────────────────────────────────────────

interface AddEditDialogProps {
  open: boolean
  editing: boolean
  form: SshForm
  onPatch: (patch: Partial<SshForm>) => void
  onSave: () => void
  onClose: () => void
}

function AddEditDialog({
  open,
  editing,
  form,
  onPatch,
  onSave,
  onClose,
}: AddEditDialogProps) {
  const { t } = useTranslation()

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
      }}
      slotProps={{
        backdrop: {
          sx: {
            background: 'rgba(20,20,22,.42)',
            backdropFilter: 'blur(2px)',
          },
        },
      }}
    >
      <Box
        sx={{
          width: 480,
          maxWidth: 'calc(100vw - 32px)',
          bgcolor: C.card,
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,.3)',
          overflow: 'hidden',
          outline: 'none',
          m: 'auto',
          animation: open ? 'scc-pop .2s cubic-bezier(.16,1,.3,1)' : 'none',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '24px',
            pt: '22px',
            pb: '18px',
          }}
        >
          <Typography
            sx={{
              fontSize: '17px',
              fontWeight: 650,
              color: C.textPrimary,
              letterSpacing: '-.01em',
              fontFamily: C.sansStack,
            }}
          >
            {editing ? t('ssh.dialog.editTitle') : t('ssh.dialog.addTitle')}
          </Typography>
          <ActionBtn onClick={onClose}>
            <CloseRoundedIcon sx={{ fontSize: 16 }} />
          </ActionBtn>
        </Box>

        {/* Form */}
        <Box
          sx={{
            px: '24px',
            pb: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px',
          }}
        >
          {/* Name */}
          <FormField label={t('ssh.field.name')}>
            <FormInput
              value={form.name}
              onChange={(v) => onPatch({ name: v })}
              placeholder={t('ssh.field.namePlaceholder')}
            />
          </FormField>

          {/* Host + Port */}
          <FormField label={t('ssh.field.host')}>
            <Box sx={{ display: 'flex', gap: '12px' }}>
              <FormInput
                value={form.host}
                onChange={(v) => onPatch({ host: v })}
                placeholder="1.2.3.4"
                mono
                style={{ flex: 1 } as CSSProperties}
              />
              <FormInput
                value={String(form.port)}
                onChange={(v) => onPatch({ port: Number(v) || 0 })}
                type="number"
                mono
                style={{ width: 92 } as CSSProperties}
              />
            </Box>
          </FormField>

          {/* Username */}
          <FormField label={t('ssh.field.username')}>
            <FormInput
              value={form.username}
              onChange={(v) => onPatch({ username: v })}
              placeholder="root"
              mono
            />
          </FormField>

          {/* Auth type selector */}
          <FormField label={t('ssh.field.authType')}>
            <SegmentedControl
              options={[
                { value: 'password', label: t('ssh.field.authPassword') },
                { value: 'key', label: t('ssh.field.authKey') },
              ]}
              value={form.authType}
              onChange={(v) => onPatch({ authType: v as 'password' | 'key' })}
            />
          </FormField>

          {/* Password or key path */}
          {form.authType === 'password' ? (
            <FormField label={t('ssh.field.password')}>
              <FormInput
                value={form.password ?? ''}
                onChange={(v) => onPatch({ password: v })}
                type="password"
                placeholder={
                  editing ? t('ssh.field.passwordEditHint') : '••••••••'
                }
              />
            </FormField>
          ) : (
            <FormField label={t('ssh.field.keyPath')}>
              <Box sx={{ display: 'flex', gap: '8px' }}>
                <FormInput
                  value={form.keyPath}
                  onChange={(v) => onPatch({ keyPath: v })}
                  placeholder="~/.ssh/id_rsa"
                  mono
                  style={{ flex: 1 } as CSSProperties}
                />
                <SecondaryBtn onClick={() => {}}>
                  {t('ssh.actions.selectFile')}
                </SecondaryBtn>
              </Box>
            </FormField>
          )}

          {/* Local SOCKS5 port */}
          <FormField label={t('ssh.field.localPort')}>
            <FormInput
              value={String(form.local_port)}
              onChange={(v) => onPatch({ local_port: Number(v) || 0 })}
              type="number"
              placeholder="10880"
              mono
            />
          </FormField>
        </Box>

        {/* Footer */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            px: '24px',
            py: '18px',
            borderTop: `1px solid ${C.metricsBarBorder}`,
          }}
        >
          <SecondaryBtn onClick={onClose}>
            {t('ssh.actions.cancel')}
          </SecondaryBtn>
          <PrimaryBtn onClick={onSave}>
            {editing ? t('ssh.actions.save') : t('ssh.actions.addTunnel')}
          </PrimaryBtn>
        </Box>
      </Box>
    </Modal>
  )
}

// ─── Import dialog (subscription-style URL import; clears existing) ───────────

interface ImportDialogProps {
  open: boolean
  url: string
  passphrase: string
  importing: boolean
  onUrlChange: (v: string) => void
  onPassphraseChange: (v: string) => void
  onConfirm: () => void
  onClose: () => void
}

function ImportDialog({
  open,
  url,
  passphrase,
  importing,
  onUrlChange,
  onPassphraseChange,
  onConfirm,
  onClose,
}: ImportDialogProps) {
  const { t } = useTranslation()

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
      }}
      slotProps={{
        backdrop: {
          sx: {
            background: 'rgba(20,20,22,.42)',
            backdropFilter: 'blur(2px)',
          },
        },
      }}
    >
      <Box
        sx={{
          width: 480,
          maxWidth: 'calc(100vw - 32px)',
          bgcolor: C.card,
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,.3)',
          overflow: 'hidden',
          outline: 'none',
          m: 'auto',
          animation: open ? 'scc-pop .2s cubic-bezier(.16,1,.3,1)' : 'none',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '24px',
            pt: '22px',
            pb: '18px',
          }}
        >
          <Typography
            sx={{
              fontSize: '17px',
              fontWeight: 650,
              color: C.textPrimary,
              letterSpacing: '-.01em',
              fontFamily: C.sansStack,
            }}
          >
            {t('ssh.importDialog.title')}
          </Typography>
          <ActionBtn onClick={onClose}>
            <CloseRoundedIcon sx={{ fontSize: 16 }} />
          </ActionBtn>
        </Box>

        {/* Body */}
        <Box
          sx={{
            px: '24px',
            pb: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px',
          }}
        >
          <FormField label={t('ssh.importDialog.urlLabel')}>
            <FormInput
              value={url}
              onChange={onUrlChange}
              placeholder={t('ssh.importDialog.urlPlaceholder')}
              mono
            />
          </FormField>

          <FormField label={t('ssh.importDialog.passphraseLabel')}>
            <FormInput
              value={passphrase}
              onChange={onPassphraseChange}
              type="password"
              placeholder={t('ssh.importDialog.passphrasePlaceholder')}
            />
          </FormField>

          {/* Clear warning */}
          <Box
            sx={{
              fontSize: '12.5px',
              lineHeight: 1.6,
              color: C.red,
              bgcolor: 'rgba(220,38,38,.07)',
              border: `1px solid rgba(220,38,38,.22)`,
              borderRadius: '10px',
              px: '12px',
              py: '10px',
              fontFamily: C.sansStack,
            }}
          >
            {t('ssh.importDialog.warning')}
          </Box>
        </Box>

        {/* Footer */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            px: '24px',
            py: '18px',
            borderTop: `1px solid ${C.metricsBarBorder}`,
          }}
        >
          <SecondaryBtn onClick={onClose} disabled={importing}>
            {t('ssh.actions.cancel')}
          </SecondaryBtn>
          <PrimaryBtn onClick={onConfirm}>
            {importing
              ? t('ssh.importDialog.importing')
              : t('ssh.importDialog.confirm')}
          </PrimaryBtn>
        </Box>
      </Box>
    </Modal>
  )
}

// ─── Export dialog (passphrase-encrypt current servers to a file) ────────────

interface ExportDialogProps {
  open: boolean
  passphrase: string
  exporting: boolean
  onPassphraseChange: (v: string) => void
  onConfirm: () => void
  onClose: () => void
}

function ExportDialog({
  open,
  passphrase,
  exporting,
  onPassphraseChange,
  onConfirm,
  onClose,
}: ExportDialogProps) {
  const { t } = useTranslation()

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
      }}
      slotProps={{
        backdrop: {
          sx: {
            background: 'rgba(20,20,22,.42)',
            backdropFilter: 'blur(2px)',
          },
        },
      }}
    >
      <Box
        sx={{
          width: 480,
          maxWidth: 'calc(100vw - 32px)',
          bgcolor: C.card,
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,.3)',
          overflow: 'hidden',
          outline: 'none',
          m: 'auto',
          animation: open ? 'scc-pop .2s cubic-bezier(.16,1,.3,1)' : 'none',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '24px',
            pt: '22px',
            pb: '18px',
          }}
        >
          <Typography
            sx={{
              fontSize: '17px',
              fontWeight: 650,
              color: C.textPrimary,
              letterSpacing: '-.01em',
              fontFamily: C.sansStack,
            }}
          >
            {t('ssh.exportDialog.title')}
          </Typography>
          <ActionBtn onClick={onClose}>
            <CloseRoundedIcon sx={{ fontSize: 16 }} />
          </ActionBtn>
        </Box>

        {/* Body */}
        <Box
          sx={{
            px: '24px',
            pb: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px',
          }}
        >
          <FormField label={t('ssh.exportDialog.passphraseLabel')}>
            <FormInput
              value={passphrase}
              onChange={onPassphraseChange}
              type="password"
              placeholder={t('ssh.exportDialog.passphrasePlaceholder')}
            />
          </FormField>

          <Box
            sx={{
              fontSize: '12.5px',
              lineHeight: 1.6,
              color: C.textMuted,
              bgcolor: '#f7f7f8',
              border: `1px solid ${C.cardBorder}`,
              borderRadius: '10px',
              px: '12px',
              py: '10px',
              fontFamily: C.sansStack,
            }}
          >
            {t('ssh.exportDialog.hint')}
          </Box>
        </Box>

        {/* Footer */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            px: '24px',
            py: '18px',
            borderTop: `1px solid ${C.metricsBarBorder}`,
          }}
        >
          <SecondaryBtn onClick={onClose} disabled={exporting}>
            {t('ssh.actions.cancel')}
          </SecondaryBtn>
          <PrimaryBtn onClick={onConfirm}>
            {exporting
              ? t('ssh.exportDialog.exporting')
              : t('ssh.exportDialog.confirm')}
          </PrimaryBtn>
        </Box>
      </Box>
    </Modal>
  )
}

// ─── Log dialog (behavior unchanged, base styling) ───────────────────────────

const LEVEL_COLOR: Record<ISshLogLevel, string> = {
  info: C.textSecondary,
  warn: C.amber,
  error: C.red,
}
const MAX_LOG_LINES = 1000

interface SshLogDialogProps {
  server: ISshServer | null
  onClose: () => void
}

type LogLine = ISshLogEntry & { _id: number }

function SshLogDialog({ server, onClose }: SshLogDialogProps) {
  const { t } = useTranslation()
  const uid = server?.uid
  const [logs, setLogs] = useState<LogLine[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!uid) return
    let active = true
    let unlisten: (() => void) | undefined

    void getSshTunnelLogs(uid).then((list) => {
      if (active) setLogs(list.map((e) => ({ ...e, _id: seqRef.current++ })))
    })
    void listen<{ uid: string; entries: ISshLogEntry[] }>(
      'verge://ssh-tunnel-log',
      (ev) => {
        if (ev.payload.uid !== uid) return
        const incoming = ev.payload.entries
        if (!incoming?.length) return
        setLogs((prev) => {
          const next = [
            ...prev,
            ...incoming.map((e) => ({ ...e, _id: seqRef.current++ })),
          ]
          return next.length > MAX_LOG_LINES
            ? next.slice(next.length - MAX_LOG_LINES)
            : next
        })
      },
    ).then((fn) => {
      if (active) unlisten = fn
      else fn()
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [uid])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [logs, autoScroll])

  const onClear = useLockFn(async () => {
    if (!uid) return
    try {
      await clearSshTunnelLogs(uid)
      setLogs([])
      showNotice('success', t('ssh.logs.cleared'))
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  return (
    <BaseDialog
      open={!!server}
      title={`${t('ssh.logs.title')}${server ? ` · ${server.name}` : ''}`}
      okBtn={t('ssh.actions.clear')}
      cancelBtn={t('ssh.actions.close')}
      onOk={onClear}
      onCancel={onClose}
      onClose={onClose}
    >
      <Box sx={{ width: 540, maxWidth: '100%' }}>
        <FormControlLabel
          sx={{ mb: 0.5 }}
          control={
            <Switch
              checked={autoScroll}
              onChange={(_, c) => setAutoScroll(c)}
            />
          }
          label={t('ssh.logs.autoScroll')}
        />
        <Box
          sx={{
            height: 360,
            overflowY: 'auto',
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.default',
            p: 1,
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {logs.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 4 }}
            >
              {t('ssh.logs.empty')}
            </Typography>
          ) : (
            logs.map((log) => (
              <Box
                key={log._id}
                sx={{
                  display: 'flex',
                  gap: 1,
                  color: LEVEL_COLOR[log.level] ?? C.textPrimary,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                <Box
                  component="span"
                  sx={{ color: C.textPlaceholder, flexShrink: 0 }}
                >
                  {log.time}
                </Box>
                <Box component="span">{log.message}</Box>
              </Box>
            ))
          )}
          <div ref={bottomRef} />
        </Box>
      </Box>
    </BaseDialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const SshPage = () => {
  const { t } = useTranslation()

  const [servers, setServers] = useState<ISshServer[]>([])
  const [statsMap, setStatsMap] = useState<Record<string, ISshTunnelStats>>({})
  const [extMap, setExtMap] = useState<Record<string, ExtStats>>({})
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<SshForm>(emptyForm)
  const [logServer, setLogServer] = useState<ISshServer | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const [importPassphrase, setImportPassphrase] = useState('')
  const [importing, setImporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPassphrase, setExportPassphrase] = useState('')
  const [exporting, setExporting] = useState(false)

  const prevStatsRef = useRef<Record<string, ISshTunnelStats>>({})
  const prevPollAtRef = useRef<Record<string, number>>({})

  const refreshServers = useCallback(async () => {
    try {
      setServers(await getSshServers())
    } catch (err) {
      console.error('[ssh] load servers failed:', err)
    }
  }, [])

  const refreshStats = useCallback(async () => {
    try {
      const newStats = await getSshTunnelStats()
      const now = Date.now()

      const next: Record<string, ExtStats> = {}
      for (const [uid, stats] of Object.entries(newStats)) {
        const prevStats = prevStatsRef.current[uid]
        const prevPollAt = prevPollAtRef.current[uid] ?? now
        const elapsed = (now - prevPollAt) / 1000

        const upRate =
          prevStats && elapsed > 0
            ? Math.max(0, (stats.up - prevStats.up) / elapsed)
            : 0
        const downRate =
          prevStats && elapsed > 0
            ? Math.max(0, (stats.down - prevStats.down) / elapsed)
            : 0

        prevPollAtRef.current[uid] = now
        next[uid] = { upRate, downRate }
      }
      setExtMap(next)

      prevStatsRef.current = newStats
      setStatsMap(newStats)
    } catch (err) {
      console.error('[ssh] load stats failed:', err)
    }
  }, [])

  useInterval(refreshStats, 1500, { immediate: true })

  useEffect(() => {
    void refreshServers()
    let unlisten: (() => void) | undefined
    void listen<{ uid: string; status: ISshTunnelStatus }>(
      'verge://ssh-tunnel-status',
      (ev) => {
        const { uid, status } = ev.payload
        setStatsMap((prev) => ({
          ...prev,
          [uid]: { ...(prev[uid] ?? emptyStats()), status },
        }))
      },
    ).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [refreshServers])

  const onToggle = useLockFn(async (server: ISshServer, next: boolean) => {
    try {
      if (next) await startSshTunnel(server.uid)
      else await stopSshTunnel(server.uid)
      await refreshServers()
      await refreshStats()
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  const onStartAll = useLockFn(async () => {
    try {
      // 后端单次落盘后逐个启动，避免前端并发 start 调用打爆 IPC / 并发写配置
      await startAllSshTunnels()
      await refreshServers()
      await refreshStats()
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  const onRestartAll = useLockFn(async () => {
    try {
      await restartAllSshTunnels()
      await refreshServers()
      await refreshStats()
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  const onConfirmImport = useLockFn(async () => {
    const url = importUrl.trim()
    if (!url) {
      showNotice('error', t('ssh.errors.importUrlRequired'))
      return
    }
    try {
      setImporting(true)
      // 后端会先清空现有全部配置，再导入并按状态启动
      const count = await importSshServers(
        url,
        importPassphrase.trim() || undefined,
      )
      setImportOpen(false)
      setImportUrl('')
      setImportPassphrase('')
      await refreshServers()
      await refreshStats()
      showNotice('success', t('ssh.importSuccess', { count }))
    } catch (err) {
      showNotice('error', `${err}`)
    } finally {
      setImporting(false)
    }
  })

  const onConfirmExport = useLockFn(async () => {
    const passphrase = exportPassphrase.trim()
    if (!passphrase) {
      showNotice('error', t('ssh.errors.passphraseRequired'))
      return
    }
    const savePath = await save({
      defaultPath: 'ssh-tunnels.cvssh',
      filters: [{ name: 'Encrypted SSH Config', extensions: ['cvssh'] }],
    })
    if (!savePath || Array.isArray(savePath)) return // 用户取消保存对话框
    try {
      setExporting(true)
      await exportSshServers(savePath, passphrase)
      setExportOpen(false)
      setExportPassphrase('')
      showNotice('success', t('ssh.exportSuccess'))
    } catch (err) {
      showNotice('error', `${err}`)
    } finally {
      setExporting(false)
    }
  })

  const onCopy = useLockFn(async (text: string) => {
    try {
      await writeText(text)
      showNotice('success', t('ssh.copied'))
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  const openAdd = () => {
    setEditing(false)
    setForm(emptyForm())
    setDialogOpen(true)
  }

  const openEdit = (server: ISshServer) => {
    setEditing(true)
    setForm({ ...server, password: '', authType: 'password', keyPath: '' })
    setDialogOpen(true)
  }

  const onSave = useLockFn(async () => {
    const host = form.host.trim()
    const username = form.username.trim()
    if (!host || !username) {
      showNotice('error', t('ssh.errors.required'))
      return
    }
    if (!editing && form.authType === 'password' && !form.password) {
      showNotice('error', t('ssh.errors.passwordRequired'))
      return
    }
    if (!form.local_port || form.local_port <= 0 || form.local_port > 65535) {
      showNotice('error', t('ssh.errors.invalidPort'))
      return
    }
    try {
      // Strip UI-only fields before sending to backend
      const { authType: _a, keyPath: _k, ...serverData } = form
      await saveSshServer({
        ...serverData,
        host,
        username,
        name: form.name.trim() || host,
        port: form.port || 22,
      })
      setDialogOpen(false)
      await refreshServers()
      await refreshStats()
      showNotice('success', t('ssh.saved'))
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  const onDelete = useLockFn(async (uid: string) => {
    try {
      await deleteSshServer(uid)
      await refreshServers()
      await refreshStats()
      showNotice('success', t('ssh.deleted'))
    } catch (err) {
      showNotice('error', `${err}`)
    }
  })

  const patchForm = (patch: Partial<SshForm>) =>
    setForm((prev) => ({ ...prev, ...patch }))

  const allEnabled = servers.length > 0 && servers.every((s) => s.enabled)

  return (
    <>
      <GlobalStyles
        styles={{
          '@keyframes ssh-pulse': {
            '0%': { transform: 'scale(1)', opacity: 0.5 },
            '100%': { transform: 'scale(2.8)', opacity: 0 },
          },
          '@keyframes scc-pop': {
            from: { opacity: 0, transform: 'translateY(8px) scale(.97)' },
            to: { opacity: 1, transform: 'none' },
          },
        }}
      />

      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: C.bg,
          fontFamily: C.sansStack,
          overflow: 'hidden',
        }}
      >
        {/* ── Fixed header row ── */}
        <Box
          data-tauri-drag-region
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            px: '34px',
            height: 58,
            borderBottom: '1px solid var(--divider-color)',
            flexShrink: 0,
            userSelect: 'none',
          }}
        >
          <Typography
            data-tauri-drag-region
            sx={{
              fontSize: '22px',
              fontWeight: 650,
              color: C.textPrimary,
              letterSpacing: '-.01em',
              fontFamily: C.sansStack,
            }}
          >
            {t('ssh.title')}
          </Typography>

          {/* Count pill */}
          <Box
            sx={{
              fontSize: '12px',
              fontWeight: 600,
              color: C.textMuted,
              bgcolor: '#e7e7e9',
              px: '9px',
              py: '2px',
              borderRadius: '999px',
              lineHeight: '1.6',
            }}
          >
            {servers.length}
          </Box>

          <Box sx={{ flex: 1 }} data-tauri-drag-region />

          <SecondaryBtn
            onClick={() => setExportOpen(true)}
            disabled={servers.length === 0}
          >
            <Box
              component="span"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <FileUploadRoundedIcon sx={{ fontSize: 15 }} />
              {t('ssh.export')}
            </Box>
          </SecondaryBtn>

          <SecondaryBtn onClick={() => setImportOpen(true)}>
            <Box
              component="span"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <FileDownloadRoundedIcon sx={{ fontSize: 15 }} />
              {t('ssh.import')}
            </Box>
          </SecondaryBtn>

          <SecondaryBtn
            onClick={allEnabled ? onRestartAll : onStartAll}
            disabled={servers.length === 0}
          >
            {allEnabled ? t('ssh.restartAll') : t('ssh.startAll')}
          </SecondaryBtn>

          <Box
            component="button"
            onClick={openAdd}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              border: 'none',
              bgcolor: C.btnPrimary,
              color: '#fff',
              cursor: 'pointer',
              px: '15px',
              py: '9px',
              borderRadius: '9px',
              fontSize: '13px',
              fontWeight: 600,
              fontFamily: C.sansStack,
              flexShrink: 0,
              transition: 'background .12s',
              '&:hover': { bgcolor: '#000' },
            }}
          >
            <AddRoundedIcon sx={{ fontSize: 14 }} />
            {t('ssh.add')}
          </Box>
        </Box>

        {/* ── Scrollable content ── */}
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            padding: '24px 34px 30px',
          }}
        >
          {servers.length === 0 ? (
            <BaseEmpty />
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {servers.map((server) => {
                const stats = statsMap[server.uid] ?? emptyStats()
                const ext = extMap[server.uid] ?? emptyExt()
                return (
                  <TunnelCard
                    key={server.uid}
                    server={server}
                    stats={stats}
                    ext={ext}
                    onToggle={(next) => onToggle(server, next)}
                    onLog={() => setLogServer(server)}
                    onEdit={() => openEdit(server)}
                    onDelete={() => onDelete(server.uid)}
                    onCopy={onCopy}
                  />
                )
              })}
            </Box>
          )}
        </Box>
      </Box>

      <AddEditDialog
        open={dialogOpen}
        editing={editing}
        form={form}
        onPatch={patchForm}
        onSave={onSave}
        onClose={() => setDialogOpen(false)}
      />

      <SshLogDialog
        key={logServer?.uid ?? 'none'}
        server={logServer}
        onClose={() => setLogServer(null)}
      />

      <ImportDialog
        open={importOpen}
        url={importUrl}
        passphrase={importPassphrase}
        importing={importing}
        onUrlChange={setImportUrl}
        onPassphraseChange={setImportPassphrase}
        onConfirm={onConfirmImport}
        onClose={() => {
          if (importing) return
          setImportOpen(false)
        }}
      />

      <ExportDialog
        open={exportOpen}
        passphrase={exportPassphrase}
        exporting={exporting}
        onPassphraseChange={setExportPassphrase}
        onConfirm={onConfirmExport}
        onClose={() => {
          if (exporting) return
          setExportOpen(false)
        }}
      />
    </>
  )
}

export default SshPage
