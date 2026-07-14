import { ShieldCheck } from 'lucide-react'
import { StatePill } from '../ui'

interface PermissionPillGroupProps {
  permissions: string[]
}

export default function PermissionPillGroup({ permissions }: PermissionPillGroupProps) {
  if (permissions.length === 0) {
    return <StatePill tone="slate" icon={<ShieldCheck size={13} />}>无额外权限</StatePill>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {permissions.map((permission) => (
        <StatePill key={permission} tone={permission.includes('network') ? 'ember' : permission.includes('write') ? 'crimson' : 'cyan'} icon={<ShieldCheck size={13} />}>
          {permission}
        </StatePill>
      ))}
    </div>
  )
}
