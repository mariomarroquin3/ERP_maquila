-- =========================================================================
-- SCRIPT UNIFICADO: REPARACIÓN DE ERROR 1442 Y NUEVA ARQUITECTURA DE PAGOS
-- =========================================================================

-- 1. ELIMINAR EL TRIGGER VIEJO (El que causaba la "Tabla Mutante" y el Error 500)
DROP TRIGGER IF EXISTS `trg_payments_before_insert`;


-- 2. AGREGAR LA COLUMNA DE CONTROL A LA TABLA DE ÓRDENES
-- NOTA: Si estás recreando la DB desde cero, puedes dejar esta línea. 
-- Si la columna ya existe, MySQL te avisará pero puedes continuar.
ALTER TABLE `orders` ADD COLUMN `total_paid` DECIMAL(10,2) NOT NULL DEFAULT 0.00;


-- 3. CONFIGURACIÓN DE MODO SEGURO Y SINCRONIZACIÓN INICIAL
-- (Apaga el cinturón de seguridad por si acaso quedó algún registro en tus tablas)
SET SQL_SAFE_UPDATES = 0;

UPDATE `orders` o
SET o.`total_paid` = COALESCE((SELECT SUM(amount) FROM `payments` WHERE order_id = o.id), 0);

SET SQL_SAFE_UPDATES = 1;


-- =========================================================================
-- 4. CREACIÓN DE LOS NUEVOS CANDADOS AUTOMÁTICOS
-- =========================================================================
DELIMITER $$

-- Limpieza preventiva de los nuevos triggers para evitar conflictos de duplicados
DROP TRIGGER IF EXISTS `trg_payments_before_insert_v2`$$
DROP TRIGGER IF EXISTS `trg_payments_after_insert`$$
DROP TRIGGER IF EXISTS `trg_payments_after_delete`$$

-- CANDADO ANTI-SOBREPAGOS (Revisa la deuda leyendo 'orders', 100% legal en MySQL)
CREATE TRIGGER `trg_payments_before_insert_v2`
BEFORE INSERT ON `payments`
FOR EACH ROW
BEGIN
    DECLARE v_order_total DECIMAL(10,2);
    DECLARE v_paid_so_far DECIMAL(10,2);

    -- Consultamos el precio total y lo que ya se pagó directamente desde la orden
    SELECT `total_price`, `total_paid` INTO v_order_total, v_paid_so_far
    FROM `orders`
    WHERE `id` = NEW.`order_id`;

    -- Si el acumulado más el nuevo pago supera el costo total, frena la operación
    IF (v_paid_so_far + NEW.`amount`) > (v_order_total + 0.01) THEN
        SIGNAL SQLSTATE '45009'
        SET MESSAGE_TEXT = 'ERR_OVERPAYMENT|El pago excede el saldo pendiente del pedido';
    END IF;
END$$

-- REDUCCIÓN DE DEUDA (Suma automáticamente el dinero pagado a la orden)
CREATE TRIGGER `trg_payments_after_insert`
AFTER INSERT ON `payments`
FOR EACH ROW
BEGIN
    UPDATE `orders`
    SET `total_paid` = `total_paid` + NEW.`amount`
    WHERE `id` = NEW.`order_id`;
END$$

-- REVERSO DE DEUDA (Si un administrador borra un pago, devuelve el saldo a la orden)
CREATE TRIGGER `trg_payments_after_delete`
AFTER DELETE ON `payments`
FOR EACH ROW
BEGIN
    UPDATE `orders`
    SET `total_paid` = `total_paid` - OLD.`amount`
    WHERE `id` = OLD.`order_id`;
END$$

DELIMITER ;