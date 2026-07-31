'use client'

import { useThread } from '@assistant-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Sparkles } from 'lucide-react'

const thinkingVariants = {
  initial: { opacity: 0, y: 20 },
  animate: { 
    opacity: 1, 
    y: 0
  },
  exit: { 
    opacity: 0, 
    y: -10
  }
}

const dotVariants = {
  initial: { scale: 0.8, opacity: 0.5 },
  animate: {
    scale: [0.8, 1.2, 0.8],
    opacity: [0.5, 1, 0.5]
  }
}

export function NexusThinkingIndicator() {
  const thread = useThread()
  const isRunning = thread.isRunning

  return (
    <AnimatePresence mode="wait">
      {isRunning && (
        <motion.div
          variants={thinkingVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex w-full gap-4 px-4 py-6"
        >
          {/* Assistant Avatar */}
          <div className="flex-shrink-0">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-[var(--mer-agent)] text-white">
                <motion.div
                  animate={{
                    rotate: 360,
                    transition: {
                      duration: 2,
                      repeat: Infinity,
                      ease: 'linear'
                    }
                  }}
                >
                  <Sparkles size={16} />
                </motion.div>
              </AvatarFallback>
            </Avatar>
          </div>

          {/* Thinking Animation */}
          <div className="flex max-w-[80%] flex-col gap-2">
            <motion.div
              className="rounded-2xl bg-muted px-4 py-3"
              whileHover={{ scale: 1.02 }}
              transition={{ duration: 0.1 }}
            >
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">
                  Nexus is thinking
                </span>
                <div className="flex gap-1">
                  {[0, 1, 2].map((index) => (
                    <motion.div
                      key={index}
                      variants={dotVariants}
                      initial="initial"
                      animate="animate"
                      transition={{
                        duration: 1.5,
                        repeat: Infinity,
                        ease: "easeInOut",
                        delay: index * 0.2
                      }}
                      className="h-1 w-1 rounded-full bg-muted-foreground"
                    />
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}