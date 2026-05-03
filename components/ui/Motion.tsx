import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface MotionProps {
    children: React.ReactNode;
    delay?: number;
    className?: string;
    onClick?: () => void;
}

export const FadeIn: React.FC<MotionProps> = ({ children, delay = 0, className, onClick }) => (
    <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.4, delay, ease: "easeOut" }}
        className={className}
        onClick={onClick}
    >
        {children}
    </motion.div>
);

export const SlideUp: React.FC<MotionProps> = ({ children, delay = 0, className, onClick }) => (
    <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay, ease: "backOut" }}
        className={className}
        onClick={onClick}
    >
        {children}
    </motion.div>
);

export const ScaleIn: React.FC<MotionProps> = ({ children, delay = 0, className, onClick }) => (
    <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay }}
        className={className}
        onClick={onClick}
    >
        {children}
    </motion.div>
);

export const StaggerContainer: React.FC<MotionProps & { stagger?: number }> = ({ children, stagger = 0.1, className }) => (
    <motion.div
        initial="hidden"
        animate="show"
        variants={{
            hidden: { opacity: 0 },
            show: {
                opacity: 1,
                transition: {
                    staggerChildren: stagger
                }
            }
        }}
        className={className}
    >
        {children}
    </motion.div>
);

export const MotionItem: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
    <motion.div
        variants={{
            hidden: { opacity: 0, y: 20 },
            show: { opacity: 1, y: 0 }
        }}
        className={className}
    >
        {children}
    </motion.div>
);
