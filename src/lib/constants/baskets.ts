/**
 * Output basket names.
 *
 * Baskets are bare strings in wallet-toolbox's `output_baskets` table and were
 * scattered as string literals across the codebase. New code should reference
 * these constants.
 */

/** wallet-toolbox's default basket for ordinary BSV outputs. */
export const DEFAULT_BASKET = 'default';

/**
 * Basket holding wallet-owned STAS token UTXOs. Created lazily the first time a
 * STAS output is internalized (`internalizeAction` basket insertion).
 */
export const STAS_BASKET = 'stas-tokens';
