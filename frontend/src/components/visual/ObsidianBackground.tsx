import { memo } from 'react'

const ObsidianBackground = memo(function ObsidianBackground() {
  return (
    <div className="fixed inset-0 pointer-events-none z-0" aria-hidden="true">
      <div className="absolute inset-0 bg-obsidian-900" />
      <div className="absolute inset-0" style={{
        backgroundImage: `
          radial-gradient(circle at 20% 5%, rgba(251,191,36,0.035) 0%, transparent 45%),
          radial-gradient(circle at 80% 90%, rgba(6,182,212,0.03) 0%, transparent 45%),
          linear-gradient(rgba(255,255,255,0.012) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.012) 1px, transparent 1px)
        `,
        backgroundSize: '100% 100%, 100% 100%, 60px 60px, 60px 60px',
      }} />
    </div>
  )
})

export default ObsidianBackground
