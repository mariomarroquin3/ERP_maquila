import { getDbPool, mockDb, MySqlCustomError, User, Product, ProductAttribute, ProductSize, Order, OrderItem, ProductionTask, WorkCalendar, Size, ProductAttributeValue, getProductionSchedule, ReworkEvent } from './db';

// Retry with exponential backoff helper for MySQL locks
export async function runWithRetry<T>(fn: () => Promise<T>, retries = 3, delay = 100): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const isLockError =
      error.errno === 1205 ||
      error.errno === 1213 ||
      error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
      error.code === 'ER_LOCK_DEADLOCK';
    if (isLockError && retries > 0) {
      console.warn(`Lock error encountered (errno: ${error.errno}). Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return runWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

// 1. Authentication Queries
export async function getUserByEmail(email: string): Promise<User | null> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    return rows.length > 0 ? rows[0] : null;
  } else {
    const user = mockDb.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    return user || null;
  }
}

export async function getUserById(id: number): Promise<User | null> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    return rows.length > 0 ? rows[0] : null;
  } else {
    const user = mockDb.users.find((u) => u.id === id);
    return user || null;
  }
}

export async function getClients(): Promise<{ id: number; full_name: string; email: string }[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query(
      'SELECT u.id, u.full_name, u.email FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = "cliente" AND u.is_active = TRUE'
    );
    return rows;
  } else {
    return mockDb.users
      .filter((u) => u.role_id === 4 && u.is_active)
      .map((u) => ({ id: u.id, full_name: u.full_name, email: u.email }));
  }
}

// 2. Catalog Queries
export async function getProducts(): Promise<Product[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query('SELECT * FROM products WHERE active = TRUE');
    return rows;
  } else {
    return mockDb.products.filter((p) => p.active);
  }
}

export async function getProductAttributes(productId: number): Promise<ProductAttribute[]> {
  const pool = await getDbPool();
  if (pool) {
    const [attrs]: any = await pool.query(
      'SELECT pa.*, at.requires_catalog_value FROM product_attributes pa JOIN attribute_types at ON pa.attribute_type_id = at.id WHERE pa.product_id = ?',
      [productId]
    );
    for (const attr of attrs) {
      if (attr.requires_catalog_value) {
        const [vals]: any = await pool.query(
          'SELECT * FROM product_attribute_values WHERE attribute_id = ? AND active = TRUE',
          [attr.id]
        );
        attr.values = vals;
      }
    }
    return attrs;
  } else {
    const attrs = mockDb.productAttributes
      .filter((pa) => pa.product_id === productId)
      .map((pa) => {
        const type = mockDb.attributeTypes.find((t) => t.id === pa.attribute_type_id);
        const requires_catalog = type ? type.requires_catalog_value : false;
        const vals = requires_catalog
          ? mockDb.productAttributeValues.filter((v) => v.attribute_id === pa.id && v.active)
          : [];
        return {
          ...pa,
          values: vals,
        };
      });
    return attrs;
  }
}

export async function getProductSizes(productId: number): Promise<ProductSize[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query(
      `SELECT ps.*, s.code as size_code, s.name as size_name 
       FROM product_sizes ps 
       JOIN sizes s ON ps.size_id = s.id 
       WHERE ps.product_id = ? AND ps.active = TRUE
       ORDER BY s.sort_order`,
      [productId]
    );
    return rows;
  } else {
    return mockDb.productSizes
      .filter((ps) => ps.product_id === productId && ps.active)
      .map((ps) => {
        const sz = mockDb.sizes.find((s) => s.id === ps.size_id);
        return {
          ...ps,
          size_code: sz?.code || '',
          size_name: sz?.name || '',
        };
      });
  }
}

// 3. Orders Queries
export async function getOrders(clientId?: number): Promise<Order[]> {
  const pool = await getDbPool();
  if (pool) {
    if (clientId) {
      const [rows]: any = await pool.query('SELECT * FROM orders WHERE client_id = ? ORDER BY estimated_delivery_date ASC', [clientId]);
      return rows;
    }
    const [rows]: any = await pool.query('SELECT * FROM orders ORDER BY estimated_delivery_date ASC');
    return rows;
  } else {
    let list = [...mockDb.orders];
    if (clientId) {
      list = list.filter((o) => o.client_id === clientId);
    }
    return list.sort((a, b) => a.estimated_delivery_date.localeCompare(b.estimated_delivery_date));
  }
}

export async function getOrderDetails(orderId: number): Promise<Order | null> {
  const pool = await getDbPool();
  if (pool) {
    const [orders]: any = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (orders.length === 0) return null;
    const order = orders[0];

    const [items]: any = await pool.query(
      `SELECT oi.*, p.name as product_name 
       FROM order_items oi 
       JOIN products p ON oi.product_id = p.id 
       WHERE oi.order_id = ?`,
      [orderId]
    );

    for (const item of items) {
      const [sizes]: any = await pool.query(
        'SELECT * FROM order_item_sizes WHERE order_item_id = ?',
        [item.id]
      );
      item.sizes = sizes;

      const [attrs]: any = await pool.query(
        'SELECT oia.*, pa.attribute_name FROM order_item_attributes oia JOIN product_attributes pa ON oia.attribute_id = pa.id WHERE oia.order_item_id = ?',
        [item.id]
      );
      item.attributes = attrs;

      const [files]: any = await pool.query(
        'SELECT * FROM order_item_files WHERE order_item_id = ?',
        [item.id]
      );
      item.files = files;
    }

    order.items = items;
    return order;
  } else {
    const order = mockDb.orders.find((o) => o.id === orderId);
    if (!order) return null;

    const items = mockDb.orderItems
      .filter((oi) => oi.order_id === orderId)
      .map((oi) => {
        const prod = mockDb.products.find((p) => p.id === oi.product_id);
        const sizes = mockDb.orderItemSizes.filter((ois) => ois.order_item_id === oi.id);
        const attrs = mockDb.orderItemAttributes.filter((oia) => oia.order_item_id === oi.id).map(oia => {
          const pa = mockDb.productAttributes.find(p => p.id === oia.attribute_id);
          return {
            ...oia,
            attribute_name: pa?.attribute_name || 'Atributo',
          };
        });
        const files = mockDb.orderItemFiles.filter((oif) => oif.order_item_id === oi.id);

        return {
          ...oi,
          product_name: prod?.name || 'Producto',
          sizes,
          attributes: attrs,
          files,
        };
      });

    return {
      ...order,
      items,
    };
  }
}

// 4. Create Order (COMPLEX TRANSACTION)
interface OrderCreationPayload {
  client_id: number;
  client_name: string;
  created_by: number;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  notes?: string;
  estimated_delivery_date: string;
  production_start_date: string;
  product_id: number;
  sizes: { product_size_id: number; quantity: number }[];
  attributes: { attribute_id: number; attribute_value_id: number | null; custom_value: string | null }[];
  files: { file_url: string; file_type?: string }[];
}

export async function createOrder(payload: OrderCreationPayload): Promise<number> {
  return runWithRetry(async () => {
    const pool = await getDbPool();
    if (pool) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // 1. Insert order
        // total_price starts at 0, computed by triggers!
        const [orderResult]: any = await conn.query(
          `INSERT INTO orders (client_id, client_name, created_by, status_id, priority, total_price, notes, estimated_delivery_date, production_start_date)
           VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?)`,
          [
            payload.client_id,
            payload.client_name,
            payload.created_by,
            payload.priority,
            payload.notes || null,
            payload.estimated_delivery_date,
            payload.production_start_date,
          ]
        );
        const orderId = orderResult.insertId;

        // 2. Fetch product base price for snapshotting
        const [prodRows]: any = await conn.query('SELECT base_price FROM products WHERE id = ?', [payload.product_id]);
        if (prodRows.length === 0) {
          throw new Error('Product not found');
        }
        const unitPrice = prodRows[0].base_price;

        // 3. Insert order item
        const [itemResult]: any = await conn.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
           VALUES (?, ?, 0, ?, 0)`,
          [orderId, payload.product_id, unitPrice]
        );
        const itemId = itemResult.insertId;

        // 4. Insert sizes (Triggers recalculation)
        for (const sz of payload.sizes) {
          await conn.query(
            `INSERT INTO order_item_sizes (order_item_id, product_size_id, quantity)
             VALUES (?, ?, ?)`,
            [itemId, sz.product_size_id, sz.quantity]
          );
        }

        // 5. Insert attributes (Triggers recalculation)
        for (const attr of payload.attributes) {
          await conn.query(
            `INSERT INTO order_item_attributes (order_item_id, attribute_id, attribute_value_id, custom_value)
             VALUES (?, ?, ?, ?)`,
            [itemId, attr.attribute_id, attr.attribute_value_id, attr.custom_value]
          );
        }

        // 6. Insert file attachments
        for (const file of payload.files) {
          await conn.query(
            `INSERT INTO order_item_files (order_item_id, file_url, file_type)
             VALUES (?, ?, ?)`,
            [itemId, file.file_url, file.file_type || 'image/jpeg']
          );
        }

        // 7. Auto-create Production Tasks for all 10 stages with distributed dates!
        const [stages]: any = await conn.query('SELECT id FROM production_stages ORDER BY sequence_order ASC');
        const totalUnits = payload.sizes.reduce((sum, s) => sum + s.quantity, 0);
        const scheduledDates = getProductionSchedule(payload.production_start_date, payload.estimated_delivery_date, stages.length);

        for (let i = 0; i < stages.length; i++) {
          const stg = stages[i];
          const taskStartDate = scheduledDates[i];
          // Triggers (trg_production_tasks_capacity_insert) will run here!
          await conn.query(
            `INSERT INTO production_tasks (order_id, order_item_id, stage_id, assigned_to, status_id, start_date, workload_points)
             VALUES (?, ?, ?, NULL, 1, ?, ?)`,
            [orderId, itemId, stg.id, taskStartDate, totalUnits]
          );
        }

        await conn.commit();
        return orderId;
      } catch (err: any) {
        await conn.rollback();
        // Standardize SQL Error state if present
        if (err.sqlState) {
          throw new MySqlCustomError(err.sqlState, err.code || 'ERR_DB', err.message);
        }
        throw err;
      } finally {
        conn.release();
      }
    } else {
      // Sandbox implementation
      const orderId = mockDb.orders.length + 1;

      // Check capacity for all 10 stages in mockDb first with distributed dates
      const totalUnits = payload.sizes.reduce((sum, s) => sum + s.quantity, 0);
      const scheduledDates = getProductionSchedule(payload.production_start_date, payload.estimated_delivery_date, 10);
      for (let i = 0; i < 10; i++) {
        const stageId = i + 1;
        const taskStartDate = scheduledDates[i];
        mockDb.validate_capacity({
          start_date: taskStartDate,
          stage_id: stageId,
          workload_points: totalUnits,
        });
      }

      // Create Order
      const newOrder: Order = {
        id: orderId,
        client_id: payload.client_id,
        client_name: payload.client_name,
        created_by: payload.created_by,
        status_id: 1, // pendiente_confirmacion
        priority: payload.priority,
        total_price: 0,
        notes: payload.notes,
        client_confirmed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        estimated_delivery_date: payload.estimated_delivery_date,
        production_start_date: payload.production_start_date,
      };
      mockDb.orders.push(newOrder);

      const prod = mockDb.products.find((p) => p.id === payload.product_id);
      if (!prod) throw new Error('Product not found');

      // Create Item
      const itemId = mockDb.orderItems.length + 1;
      const newItem: OrderItem = {
        id: itemId,
        order_id: orderId,
        product_id: payload.product_id,
        quantity: 0,
        unit_price: prod.base_price,
        subtotal: 0,
        custom_notes: payload.notes,
      };
      mockDb.orderItems.push(newItem);

      // Create Sizes
      payload.sizes.forEach((sz) => {
        const prodSize = mockDb.productSizes.find((ps) => ps.id === sz.product_size_id);
        if (!prodSize) throw new Error('Product size not found');
        const sizeName = mockDb.sizes.find((s) => s.id === prodSize.size_id)?.name || 'Size';

        mockDb.orderItemSizes.push({
          id: mockDb.orderItemSizes.length + 1,
          order_item_id: itemId,
          product_size_id: sz.product_size_id,
          size_label: sizeName,
          price_modifier_snapshot: prodSize.price_modifier,
          quantity: sz.quantity,
        });
      });

      // Create Attributes
      payload.attributes.forEach((attr) => {
        const prodAttr = mockDb.productAttributes.find((pa) => pa.id === attr.attribute_id);
        if (!prodAttr) throw new Error('Attribute not found');

        let priceMod = 0;
        let label = attr.custom_value || '';

        if (attr.attribute_value_id) {
          const val = mockDb.productAttributeValues.find((v) => v.id === attr.attribute_value_id);
          if (val) {
            priceMod = val.price_modifier;
            label = val.value;
          }
        }

        mockDb.orderItemAttributes.push({
          id: mockDb.orderItemAttributes.length + 1,
          order_item_id: itemId,
          attribute_id: attr.attribute_id,
          attribute_value_id: attr.attribute_value_id,
          custom_value: attr.custom_value,
          value_label: label,
          price_modifier_snapshot: priceMod,
        });
      });

      // Files
      payload.files.forEach((f) => {
        mockDb.orderItemFiles.push({
          id: mockDb.orderItemFiles.length + 1,
          order_item_id: itemId,
          file_url: f.file_url,
          file_type: f.file_type || 'image/jpeg',
          uploaded_at: new Date().toISOString(),
        });
      });

      // Run recalc trigger triggers
      mockDb.sp_recalc_order_item_subtotal(itemId);
      mockDb.sp_recalc_order_total(orderId);

      // Create Tasks for all 10 stages with distributed dates
      for (let i = 0; i < 10; i++) {
        const stageId = i + 1;
        const taskStartDate = scheduledDates[i];
        mockDb.productionTasks.push({
          id: mockDb.productionTasks.length + 1,
          order_id: orderId,
          order_item_id: itemId,
          stage_id: stageId,
          assigned_to: null,
          status_id: 1, // pendiente
          start_date: taskStartDate,
          workload_points: totalUnits,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      return orderId;
    }
  });
}

// 5. Production Tasks Queries (Kanban Board)
export async function getProductionTasks(dateStr?: string, orderId?: number): Promise<ProductionTask[]> {
  const pool = await getDbPool();

  if (pool) {
    if (orderId) {
      const [rows]: any = await pool.query(
        `SELECT pt.*, 
                ps.name as stage_name, 
                pst.name as status_name, 
                u.full_name as assigned_name,
                p.name as product_name,
                o.client_name as client_name
         FROM production_tasks pt
         JOIN production_stages ps ON pt.stage_id = ps.id
         JOIN production_status pst ON pt.status_id = pst.id
         LEFT JOIN users u ON pt.assigned_to = u.id
         JOIN orders o ON pt.order_id = o.id
         JOIN order_items oi ON pt.order_item_id = oi.id
         JOIN products p ON oi.product_id = p.id
         WHERE pt.order_id = ?
         ORDER BY ps.sequence_order ASC, pt.id ASC`,
        [orderId]
      );
      return rows;
    } else {
      const queryDate = dateStr || new Date().toISOString().split('T')[0];
      const [rows]: any = await pool.query(
        `SELECT pt.*, 
                ps.name as stage_name, 
                pst.name as status_name, 
                u.full_name as assigned_name,
                p.name as product_name,
                o.client_name as client_name
         FROM production_tasks pt
         JOIN production_stages ps ON pt.stage_id = ps.id
         JOIN production_status pst ON pt.status_id = pst.id
         LEFT JOIN users u ON pt.assigned_to = u.id
         JOIN orders o ON pt.order_id = o.id
         JOIN order_items oi ON pt.order_item_id = oi.id
         JOIN products p ON oi.product_id = p.id
         WHERE pt.start_date = ?
         ORDER BY ps.sequence_order ASC, pt.id ASC`,
        [queryDate]
      );
      return rows;
    }
  } else {
    if (orderId) {
      return mockDb.productionTasks
        .filter((t) => t.order_id === orderId)
        .map((t) => {
          const stage = mockDb.productionStages.find((s) => s.id === t.stage_id);
          const status = mockDb.productionStatus.find((s) => s.id === t.status_id);
          const assigned = mockDb.users.find((u) => u.id === t.assigned_to);
          const item = mockDb.orderItems.find((oi) => oi.id === t.order_item_id);
          const prod = item ? mockDb.products.find((p) => p.id === item.product_id) : null;
          const order = mockDb.orders.find((o) => o.id === t.order_id);

          return {
            ...t,
            stage_name: stage?.name || 'Etapa',
            status_name: status?.name || 'Pendiente',
            assigned_name: assigned?.full_name || 'Sin Asignar',
            product_name: prod?.name || 'Producto',
            client_name: order?.client_name || 'Cliente',
          };
        });
    } else {
      const queryDate = dateStr || new Date().toISOString().split('T')[0];
      return mockDb.productionTasks
        .filter((t) => t.start_date === queryDate)
        .map((t) => {
          const stage = mockDb.productionStages.find((s) => s.id === t.stage_id);
          const status = mockDb.productionStatus.find((s) => s.id === t.status_id);
          const assigned = mockDb.users.find((u) => u.id === t.assigned_to);
          const item = mockDb.orderItems.find((oi) => oi.id === t.order_item_id);
          const prod = item ? mockDb.products.find((p) => p.id === item.product_id) : null;
          const order = mockDb.orders.find((o) => o.id === t.order_id);

          return {
            ...t,
            stage_name: stage?.name || 'Etapa',
            status_name: status?.name || 'Pendiente',
            assigned_name: assigned?.full_name || 'Sin Asignar',
            product_name: prod?.name || 'Producto',
            client_name: order?.client_name || 'Cliente',
          };
        });
    }
  }
}

export async function getProductionTasksPendingReview(): Promise<any[]> {
  const pool = await getDbPool();

  if (pool) {
    const [rows]: any = await pool.query(
      `SELECT pt.*, 
              ps.name as stage_name, 
              pst.name as status_name, 
              u.full_name as assigned_name,
              p.name as product_name,
              o.client_name as client_name,
              o.priority as order_priority,
              o.estimated_delivery_date as order_delivery_date
       FROM production_tasks pt
       JOIN production_stages ps ON pt.stage_id = ps.id
       JOIN production_status pst ON pt.status_id = pst.id
       LEFT JOIN users u ON pt.assigned_to = u.id
       JOIN orders o ON pt.order_id = o.id
       JOIN order_items oi ON pt.order_item_id = oi.id
       JOIN products p ON oi.product_id = p.id
       WHERE pt.status_id = 5
       ORDER BY 
         CASE o.priority
           WHEN 'urgent' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
           ELSE 5
         END,
         o.estimated_delivery_date ASC`
    );
    return rows;
  } else {
    const pendingTasks = mockDb.productionTasks
      .filter((t) => t.status_id === 5)
      .map((t) => {
        const stage = mockDb.productionStages.find((s) => s.id === t.stage_id);
        const status = mockDb.productionStatus.find((s) => s.id === t.status_id);
        const assigned = mockDb.users.find((u) => u.id === t.assigned_to);
        const item = mockDb.orderItems.find((oi) => oi.id === t.order_item_id);
        const prod = item ? mockDb.products.find((p) => p.id === item.product_id) : null;
        const order = mockDb.orders.find((o) => o.id === t.order_id);

        return {
          ...t,
          stage_name: stage?.name || 'Etapa',
          status_name: status?.name || 'Listo para revisión',
          assigned_name: assigned?.full_name || 'Sin Asignar',
          product_name: prod?.name || 'Producto',
          client_name: order?.client_name || 'Cliente',
          order_priority: order?.priority || 'medium',
          order_delivery_date: order?.estimated_delivery_date || '',
        };
      });

    // Sort by priority and delivery date
    pendingTasks.sort((a, b) => {
      const priorityWeight: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
      const weightA = priorityWeight[a.order_priority || 'medium'] || 3;
      const weightB = priorityWeight[b.order_priority || 'medium'] || 3;
      if (weightA !== weightB) return weightA - weightB;
      return a.order_delivery_date.localeCompare(b.order_delivery_date);
    });

    return pendingTasks;
  }
}

// Update task status (with FOR UPDATE lock emulation and triggers)
export async function updateTaskStatus(
  taskId: number,
  statusId: number,
  userId: number,
  comment?: string
): Promise<void> {
  return runWithRetry(async () => {
    const pool = await getDbPool();
    if (pool) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Lock task row
        const [tasks]: any = await conn.query(
          'SELECT * FROM production_tasks WHERE id = ? FOR UPDATE',
          [taskId]
        );
        if (tasks.length === 0) {
          throw new Error('Task not found');
        }
        const task = tasks[0];

        // If stage completes (e.g. statusId = 3 completado), we might set actual end date
        const endDateActual = statusId === 3 ? new Date().toISOString().split('T')[0] : null;

        await conn.query(
          `UPDATE production_tasks 
           SET status_id = ?, end_date_actual = ?, assigned_to = COALESCE(assigned_to, ?)
           WHERE id = ?`,
          [statusId, endDateActual, userId, taskId]
        );

        // Insert task history log
        await conn.query(
          `INSERT INTO production_task_history (production_task_id, status_id, changed_by, comment)
           VALUES (?, ?, ?, ?)`,
          [taskId, statusId, userId, comment || 'Actualización de estado en el taller']
        );

        // If this is the final stage (despachado, stage_id = 10) and is completed, maybe mark order status
        if (task.stage_id === 10 && statusId === 3) {
          // Check if all tasks for this order are completed
          const [allTasks]: any = await conn.query(
            'SELECT status_id FROM production_tasks WHERE order_id = ?',
            [task.order_id]
          );
          const allDone = allTasks.every((t: any) => t.status_id === 3);
          if (allDone) {
            await conn.query(
              'UPDATE orders SET status_id = 4 WHERE id = ?', // listo_entrega (4)
              [task.order_id]
            );
          }
        }

        await conn.commit();
      } catch (err: any) {
        await conn.rollback();
        if (err.sqlState) {
          throw new MySqlCustomError(err.sqlState, err.code || 'ERR_DB', err.message);
        }
        throw err;
      } finally {
        conn.release();
      }
    } else {
      // Sandbox
      const taskIndex = mockDb.productionTasks.findIndex((t) => t.id === taskId);
      if (taskIndex === -1) throw new Error('Task not found');
      const task = mockDb.productionTasks[taskIndex];

      task.status_id = statusId;
      if (statusId === 3) {
        task.end_date_actual = new Date().toISOString().split('T')[0];
      }
      if (!task.assigned_to) {
        task.assigned_to = userId;
      }
      task.updated_at = new Date().toISOString();

      // History
      mockDb.productionTaskHistory.push({
        id: mockDb.productionTaskHistory.length + 1,
        production_task_id: taskId,
        status_id: statusId,
        changed_by: userId,
        changed_at: new Date().toISOString(),
        comment: comment || 'Actualización de taller registrada',
      });

      // If final stage (despachado id=10) is completado (id=3), check if order needs update
      if (task.stage_id === 10 && statusId === 3) {
        const orderTasks = mockDb.productionTasks.filter((t) => t.order_id === task.order_id);
        const allDone = orderTasks.every((t) => t.status_id === 3);
        if (allDone) {
          const ord = mockDb.orders.find((o) => o.id === task.order_id);
          if (ord) {
            ord.status_id = 4; // listo_entrega
            ord.updated_at = new Date().toISOString();
          }
        }
      }
    }
  });
}

// 6. Capacity Queries (Work Calendar CRUD)
export async function getCapacityCalendar(startDate: string, endDate: string): Promise<WorkCalendar[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query(
      'SELECT * FROM work_calendar WHERE work_date BETWEEN ? AND ? ORDER BY work_date ASC, stage_id ASC',
      [startDate, endDate]
    );
    return rows;
  } else {
    return mockDb.workCalendar
      .filter((c) => c.work_date >= startDate && c.work_date <= endDate)
      .sort((a, b) => a.work_date.localeCompare(b.work_date) || a.stage_id - b.stage_id);
  }
}

// Update capacity definition
export async function saveCapacityCalendar(configs: { work_date: string; stage_id: number; max_capacity_points: number; is_working_day: boolean; notes?: string }[]): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const config of configs) {
        // UPSERT in MySQL
        await conn.query(
          `INSERT INTO work_calendar (work_date, stage_id, max_capacity_points, is_working_day, notes)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             max_capacity_points = VALUES(max_capacity_points),
             is_working_day = VALUES(is_working_day),
             notes = VALUES(notes)`,
          [config.work_date, config.stage_id, config.max_capacity_points, config.is_working_day, config.notes || null]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    // Sandbox
    configs.forEach((config) => {
      const matchIndex = mockDb.workCalendar.findIndex(
        (c) => c.work_date === config.work_date && c.stage_id === config.stage_id
      );

      if (matchIndex !== -1) {
        mockDb.workCalendar[matchIndex].max_capacity_points = config.max_capacity_points;
        mockDb.workCalendar[matchIndex].is_working_day = config.is_working_day;
        mockDb.workCalendar[matchIndex].notes = config.notes;
      } else {
        mockDb.workCalendar.push({
          id: mockDb.workCalendar.length + 1,
          ...config,
        });
      }
    });
  }
}

// 7. Get Committed capacity points per day/stage
export async function getCapacityCommitted(startDate: string, endDate: string): Promise<{ work_date: string; stage_id: number; committed_points: number }[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query(
      `SELECT pt.start_date as work_date, pt.stage_id, SUM(pt.workload_points) as committed_points
       FROM production_tasks pt
       JOIN orders o ON pt.order_id = o.id
       WHERE pt.start_date BETWEEN ? AND ? AND o.status_id != 6
       GROUP BY pt.start_date, pt.stage_id`,
      [startDate, endDate]
    );
    return rows;
  } else {
    const groups: Record<string, number> = {};
    mockDb.productionTasks.forEach((t) => {
      const o = mockDb.orders.find((ord) => ord.id === t.order_id);
      const orderIsCancelled = o && o.status_id === 6;
      if (t.start_date >= startDate && t.start_date <= endDate && !orderIsCancelled) {
        const key = `${t.start_date}_${t.stage_id}`;
        groups[key] = (groups[key] || 0) + t.workload_points;
      }
    });
    return Object.entries(groups).map(([key, committed_points]) => {
      const [work_date, stage_id] = key.split('_');
      return {
        work_date,
        stage_id: parseInt(stage_id, 10),
        committed_points,
      };
    });
  }
}

// 8. CRUD catalogs
// Products
export async function createProduct(name: string, basePrice: number, typeId: number): Promise<number> {
  const pool = await getDbPool();
  if (pool) {
    const [res]: any = await pool.query(
      'INSERT INTO products (name, base_price, active, product_type_id) VALUES (?, ?, TRUE, ?)',
      [name, basePrice, typeId]
    );
    return res.insertId;
  } else {
    const id = mockDb.products.length + 1;
    mockDb.products.push({ id, name, base_price: basePrice, active: true, product_type_id: typeId });
    return id;
  }
}

export async function updateProduct(id: number, name: string, basePrice: number, typeId: number, active: boolean): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    await pool.query(
      'UPDATE products SET name = ?, base_price = ?, product_type_id = ?, active = ? WHERE id = ?',
      [name, basePrice, typeId, active, id]
    );
  } else {
    const idx = mockDb.products.findIndex((p) => p.id === id);
    if (idx !== -1) {
      mockDb.products[idx] = { ...mockDb.products[idx], name, base_price: basePrice, product_type_id: typeId, active };
    }
  }
}

// Sizes Catalogs
export async function createCatalogSize(code: string, name: string, sortOrder: number): Promise<number> {
  const pool = await getDbPool();
  if (pool) {
    const [res]: any = await pool.query('INSERT INTO sizes (code, name, sort_order) VALUES (?, ?, ?)', [code, name, sortOrder]);
    return res.insertId;
  } else {
    const id = mockDb.sizes.length + 1;
    mockDb.sizes.push({ id, code, name, sort_order: sortOrder });
    return id;
  }
}

export async function getCatalogSizes(): Promise<Size[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query('SELECT * FROM sizes ORDER BY sort_order ASC');
    return rows;
  } else {
    return [...mockDb.sizes].sort((a, b) => a.sort_order - b.sort_order);
  }
}

// Product Attributes (CRUD inside products)
export async function addProductAttribute(productId: number, name: string, typeId: number, isRequired: boolean, values: string[]): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res]: any = await conn.query(
        'INSERT INTO product_attributes (product_id, attribute_name, attribute_type_id, is_required) VALUES (?, ?, ?, ?)',
        [productId, name, typeId, isRequired]
      );
      const attrId = res.insertId;

      // If requires catalog values
      const [typeRows]: any = await conn.query('SELECT requires_catalog_value FROM attribute_types WHERE id = ?', [typeId]);
      if (typeRows.length > 0 && typeRows[0].requires_catalog_value) {
        for (const val of values) {
          await conn.query(
            'INSERT INTO product_attribute_values (attribute_id, value, price_modifier, active) VALUES (?, ?, 0, TRUE)',
            [attrId, val]
          );
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    const attrId = mockDb.productAttributes.length + 1;
    mockDb.productAttributes.push({
      id: attrId,
      product_id: productId,
      attribute_name: name,
      attribute_type_id: typeId,
      is_required: isRequired,
    });

    const isCatalog = [1, 2].includes(typeId); // select or color
    if (isCatalog) {
      values.forEach((v) => {
        mockDb.productAttributeValues.push({
          id: mockDb.productAttributeValues.length + 1,
          attribute_id: attrId,
          value: v,
          price_modifier: 0,
          active: true,
        });
      });
    }
  }
}

// Add valid size for product
export async function addProductSize(productId: number, sizeId: number, priceModifier: number): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    await pool.query(
      `INSERT INTO product_sizes (product_id, size_id, price_modifier, active) 
       VALUES (?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE price_modifier = VALUES(price_modifier), active = TRUE`,
      [productId, sizeId, priceModifier]
    );
  } else {
    const matchIdx = mockDb.productSizes.findIndex((ps) => ps.product_id === productId && ps.size_id === sizeId);
    if (matchIdx !== -1) {
      mockDb.productSizes[matchIdx].price_modifier = priceModifier;
      mockDb.productSizes[matchIdx].active = true;
    } else {
      mockDb.productSizes.push({
        id: mockDb.productSizes.length + 1,
        product_id: productId,
        size_id: sizeId,
        price_modifier: priceModifier,
        active: true,
      });
    }
  }
}

// Edit existing product attribute (name, required status, and attribute values)
export async function updateProductAttribute(
  attributeId: number,
  productId: number,
  name: string,
  isRequired: boolean,
  values: { id?: number; value: string; price_modifier: number; active: boolean }[]
): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Update attribute main fields
      await conn.query(
        'UPDATE product_attributes SET attribute_name = ?, is_required = ? WHERE id = ? AND product_id = ?',
        [name, isRequired ? 1 : 0, attributeId, productId]
      );

      // Get existing values to detect omissions
      const [existingRows]: any = await conn.query(
        'SELECT id FROM product_attribute_values WHERE attribute_id = ?',
        [attributeId]
      );
      const existingIds = existingRows.map((r: any) => r.id);
      const inputIds = values.filter((v) => v.id).map((v) => v.id!);

      // Deactivate omitted values
      const idsToDeactivate = existingIds.filter((id: number) => !inputIds.includes(id));
      if (idsToDeactivate.length > 0) {
        await conn.query(
          'UPDATE product_attribute_values SET active = FALSE WHERE id IN (?)',
          [idsToDeactivate]
        );
      }

      // Upsert input values
      for (const val of values) {
        if (val.id) {
          await conn.query(
            'UPDATE product_attribute_values SET value = ?, price_modifier = ?, active = ? WHERE id = ? AND attribute_id = ?',
            [val.value, parseFloat(val.price_modifier as any), val.active ? 1 : 0, val.id, attributeId]
          );
        } else {
          await conn.query(
            'INSERT INTO product_attribute_values (attribute_id, value, price_modifier, active) VALUES (?, ?, ?, ?)',
            [attributeId, val.value, parseFloat(val.price_modifier as any), val.active ? 1 : 0]
          );
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    // Sandbox
    const attrIdx = mockDb.productAttributes.findIndex((pa) => pa.id === attributeId && pa.product_id === productId);
    if (attrIdx !== -1) {
      mockDb.productAttributes[attrIdx].attribute_name = name;
      mockDb.productAttributes[attrIdx].is_required = isRequired;

      const existingVals = mockDb.productAttributeValues.filter((v) => v.attribute_id === attributeId);
      const inputIds = values.filter((v) => v.id).map((v) => v.id!);

      // Deactivate omitted
      existingVals.forEach((v) => {
        if (!inputIds.includes(v.id)) {
          v.active = false;
        }
      });

      // Upsert
      values.forEach((val) => {
        if (val.id) {
          const vIdx = mockDb.productAttributeValues.findIndex((v) => v.id === val.id && v.attribute_id === attributeId);
          if (vIdx !== -1) {
            mockDb.productAttributeValues[vIdx].value = val.value;
            mockDb.productAttributeValues[vIdx].price_modifier = parseFloat(val.price_modifier as any);
            mockDb.productAttributeValues[vIdx].active = val.active;
          }
        } else {
          mockDb.productAttributeValues.push({
            id: mockDb.productAttributeValues.length + 1,
            attribute_id: attributeId,
            value: val.value,
            price_modifier: parseFloat(val.price_modifier as any),
            active: val.active,
          });
        }
      });
    }
  }
}

// Bulk update valid sizes for a product (active status and price modifiers)
export async function updateProductSizes(
  productId: number,
  sizes: { size_id: number; price_modifier: number; active: boolean }[]
): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const sz of sizes) {
        await conn.query(
          `INSERT INTO product_sizes (product_id, size_id, price_modifier, active) 
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE price_modifier = VALUES(price_modifier), active = VALUES(active)`,
          [productId, sz.size_id, parseFloat(sz.price_modifier as any), sz.active ? 1 : 0]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    // Sandbox
    sizes.forEach((sz) => {
      const matchIdx = mockDb.productSizes.findIndex((ps) => ps.product_id === productId && ps.size_id === sz.size_id);
      if (matchIdx !== -1) {
        mockDb.productSizes[matchIdx].price_modifier = parseFloat(sz.price_modifier as any);
        mockDb.productSizes[matchIdx].active = sz.active;
      } else {
        mockDb.productSizes.push({
          id: mockDb.productSizes.length + 1,
          product_id: productId,
          size_id: sz.size_id,
          price_modifier: parseFloat(sz.price_modifier as any),
          active: sz.active,
        });
      }
    });
  }
}

// ==========================================
// NEW ADVANCED ERP MODULES (PAYMENTS, BILLING, STATE MACHINE, AUDITING, REPORTS)
// ==========================================

export async function createAuditLog(userName: string, action: string, oldValue: string, newValue: string): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS audit_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_name VARCHAR(255) NOT NULL,
          action TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          old_value TEXT,
          new_value TEXT
        )`
      );
      await pool.query(
        'INSERT INTO audit_logs (user_name, action, old_value, new_value) VALUES (?, ?, ?, ?)',
        [userName, action, oldValue, newValue]
      );
    } catch (err) {
      console.error('Failed to write MySQL audit log:', err);
    }
  } else {
    mockDb.auditLogs.push({
      id: mockDb.auditLogs.length + 1,
      user_name: userName,
      action,
      created_at: new Date().toISOString(),
      old_value: oldValue,
      new_value: newValue
    });
  }
}

export async function getAuditLogs(): Promise<any[]> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS audit_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_name VARCHAR(255) NOT NULL,
          action TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          old_value TEXT,
          new_value TEXT
        )`
      );
      const [rows]: any = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
      return rows;
    } catch (err) {
      console.error('Failed to get MySQL audit logs:', err);
      return [];
    }
  } else {
    return [...mockDb.auditLogs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}

export async function getPayments(orderId?: number): Promise<any[]> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS payments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          payment_method VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          notes TEXT,
          registered_by INT NOT NULL
        )`
      );
      if (orderId) {
        const [rows]: any = await pool.query(
          `SELECT p.*, u.full_name as registered_by_name 
           FROM payments p 
           LEFT JOIN users u ON p.registered_by = u.id 
           WHERE p.order_id = ? 
           ORDER BY p.created_at DESC`,
          [orderId]
        );
        return rows;
      } else {
        const [rows]: any = await pool.query(
          `SELECT p.*, u.full_name as registered_by_name 
           FROM payments p 
           LEFT JOIN users u ON p.registered_by = u.id 
           ORDER BY p.created_at DESC`
        );
        return rows;
      }
    } catch (err) {
      console.error('Failed to get MySQL payments:', err);
      return [];
    }
  } else {
    let list = [...mockDb.payments].map((p) => {
      const u = mockDb.users.find((user) => user.id === p.registered_by);
      return {
        ...p,
        registered_by_name: u ? u.full_name : 'Sistema'
      };
    });
    if (orderId) {
      list = list.filter((p) => p.order_id === orderId);
    }
    return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}

export async function createPayment(
  orderId: number,
  amount: number,
  paymentMethod: 'efectivo' | 'tarjeta' | 'transferencia',
  notes: string,
  userId: number,
  userName: string
): Promise<number> {
  const pool = await getDbPool();
  
  // First fetch order to check total price and status
  const order = await getOrderDetails(orderId);
  if (!order) {
    throw new Error('Pedido no encontrado');
  }

  const existingPayments = await getPayments(orderId);
  const totalPaidSoFar = existingPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  
  if (totalPaidSoFar + amount > order.total_price + 0.01) {
    throw new MySqlCustomError(
      '45009',
      'ERR_OVERPAYMENT',
      `El pago de $${amount} excede el saldo pendiente de $${(order.total_price - totalPaidSoFar).toFixed(2)}. Total del pedido: $${order.total_price.toFixed(2)}.`
    );
  }

  let paymentId = 0;
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `CREATE TABLE IF NOT EXISTS payments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          payment_method VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          notes TEXT,
          registered_by INT NOT NULL
        )`
      );
      const [res]: any = await conn.query(
        `INSERT INTO payments (order_id, amount, payment_method, notes, registered_by)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, amount, paymentMethod, notes || null, userId]
      );
      paymentId = res.insertId;
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    paymentId = mockDb.payments.length + 1;
    mockDb.payments.push({
      id: paymentId,
      order_id: orderId,
      amount,
      payment_method: paymentMethod,
      created_at: new Date().toISOString(),
      notes,
      registered_by: userId
    });
  }

  // Log in Audit Logs
  await createAuditLog(
    userName,
    `Pago registrado - Pedido #${orderId}`,
    `Pagado anteriormente: $${totalPaidSoFar.toFixed(2)}`,
    `Nuevo pago de: $${amount.toFixed(2)} (Método: ${paymentMethod})`
  );

  return paymentId;
}

export async function getInvoices(orderId?: number): Promise<any[]> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS invoices (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          invoice_number VARCHAR(100) NOT NULL UNIQUE,
          subtotal DECIMAL(10,2) NOT NULL,
          tax DECIMAL(10,2) NOT NULL,
          discount DECIMAL(10,2) NOT NULL,
          total DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          invoice_type VARCHAR(50) NOT NULL
        )`
      );
      if (orderId) {
        const [rows]: any = await pool.query('SELECT * FROM invoices WHERE order_id = ? ORDER BY created_at DESC', [orderId]);
        return rows;
      } else {
        const [rows]: any = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC');
        return rows;
      }
    } catch (err) {
      console.error('Failed to get MySQL invoices:', err);
      return [];
    }
  } else {
    let list = [...mockDb.invoices];
    if (orderId) {
      list = list.filter((i) => i.order_id === orderId);
    }
    return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}

export async function createInvoice(
  orderId: number,
  invoiceType: 'consumidor_final' | 'credito_fiscal',
  discount: number,
  tax: number,
  userName: string,
  userRole: string
): Promise<number> {
  const pool = await getDbPool();
  
  // First fetch order to check total price
  const order = await getOrderDetails(orderId);
  if (!order) {
    throw new Error('Pedido no encontrado');
  }

  // Business Rule: Discounts above 15% require admin role
  const discountPercentage = (discount / order.total_price) * 100;
  if (discountPercentage > 15 && userRole !== 'admin') {
    throw new MySqlCustomError(
      '45010',
      'ERR_DISCOUNT_UNAUTHORIZED',
      `El descuento de $${discount.toFixed(2)} (${discountPercentage.toFixed(1)}%) supera el límite del 15% permitido para su rol. Solicite autorización de un administrador.`
    );
  }

  const invoiceNumber = `FAC-${1000 + Math.floor(Math.random() * 9000)}-${new Date().getFullYear()}`;
  const subtotal = order.total_price;
  const total = subtotal + tax - discount;

  let invoiceId = 0;
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `CREATE TABLE IF NOT EXISTS invoices (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          invoice_number VARCHAR(100) NOT NULL UNIQUE,
          subtotal DECIMAL(10,2) NOT NULL,
          tax DECIMAL(10,2) NOT NULL,
          discount DECIMAL(10,2) NOT NULL,
          total DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          invoice_type VARCHAR(50) NOT NULL
        )`
      );
      const [res]: any = await conn.query(
        `INSERT INTO invoices (order_id, invoice_number, subtotal, tax, discount, total, invoice_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, invoiceNumber, subtotal, tax, discount, total, invoiceType]
      );
      invoiceId = res.insertId;
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    invoiceId = mockDb.invoices.length + 1;
    mockDb.invoices.push({
      id: invoiceId,
      order_id: orderId,
      invoice_number: invoiceNumber,
      subtotal,
      tax,
      discount,
      total,
      created_at: new Date().toISOString(),
      invoice_type: invoiceType
    });
  }

  // Log in Audit Logs
  await createAuditLog(
    userName,
    `Factura emitida - Pedido #${orderId}`,
    '-',
    `Factura #${invoiceNumber} por total de $${total.toFixed(2)} (Subtotal: $${subtotal.toFixed(2)}, Impuestos: $${tax.toFixed(2)}, Descuento: $${discount.toFixed(2)})`
  );

  return invoiceId;
}

export async function updateOrderStatus(
  orderId: number,
  statusId: number,
  userId: number,
  userName: string,
  userRole: string,
  comment?: string
): Promise<void> {
  const pool = await getDbPool();
  
  // Fetch current state
  const order = await getOrderDetails(orderId);
  if (!order) {
    throw new Error('Pedido no encontrado');
  }

  const oldStatusId = order.status_id;
  if (oldStatusId === statusId) return;

  // Enforce strict state transition rules (State Machine)
  // Status IDs: 1 (pendiente_confirmacion), 2 (confirmado), 3 (en_produccion), 4 (listo_entrega), 5 (entregado), 6 (cancelado)
  if (oldStatusId === 5 || oldStatusId === 6) {
    throw new MySqlCustomError(
      '45011',
      'ERR_TERMINAL_STATE',
      'No se puede cambiar el estado de un pedido que ya está en estado terminal (Entregado o Cancelado).'
    );
  }

  // Strict transition paths
  if (statusId === 3 && oldStatusId !== 2) {
    throw new MySqlCustomError(
      '45012',
      'ERR_INVALID_TRANSITION',
      'Un pedido sólo puede pasar a "En Producción" si primero ha sido "Confirmado".'
    );
  }
  if (statusId === 4 && oldStatusId !== 3) {
    throw new MySqlCustomError(
      '45012',
      'ERR_INVALID_TRANSITION',
      'Un pedido sólo puede pasar a "Listo para Entrega" si primero estuvo "En Producción".'
    );
  }

  // Financial Control Check: Preventing delivery of outstanding balance without admin authorization
  if (statusId === 5) {
    const payments = await getPayments(orderId);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = order.total_price - totalPaid;
    
    if (balance > 0.01 && userRole !== 'admin') {
      throw new MySqlCustomError(
        '45013',
        'ERR_OUTSTANDING_BALANCE',
        `No se permite registrar la entrega del pedido #${orderId} con un saldo pendiente de $${balance.toFixed(2)}, a menos que cuente con autorización del Administrador.`
      );
    }
  }

  // Perform Update
  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE orders SET status_id = ?, updated_at = NOW() WHERE id = ?',
        [statusId, orderId]
      );

      // Si el pedido fue entregado, mover todas las tareas a Despachado
      if (statusId === 5) {
        await conn.query(
          `UPDATE production_tasks
           SET
             stage_id = 10,
             status_id = 3,
             end_date_actual = CURDATE(),
             updated_at = NOW()
           WHERE order_id = ?`,
          [orderId]
        );
      }

      // Add order status history log
      await conn.query(
        'INSERT INTO order_status_history (order_id, status_id, changed_by, comment) VALUES (?, ?, ?, ?)',
        [orderId, statusId, userId, comment || 'Cambio de estado general']
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    const idx = mockDb.orders.findIndex((o) => o.id === orderId);
    if (idx !== -1) {
      mockDb.orders[idx].status_id = statusId;

      if (statusId === 5) {
        mockDb.productionTasks
          .filter(t => t.order_id === orderId)
          .forEach(t => {
            t.stage_id = 10;
            t.status_id = 3;
            t.end_date_actual = new Date().toISOString().split('T')[0];
            t.updated_at = new Date().toISOString();
          });
      }
      
      mockDb.orders[idx].updated_at = new Date().toISOString();
    }
    mockDb.orderStatusHistory.push({
      id: mockDb.orderStatusHistory.length + 1,
      order_id: orderId,
      status_id: statusId,
      changed_by: userId,
      changed_at: new Date().toISOString(),
      comment: comment || 'Estado de pedido modificado'
    });
  }

  // Log in Audit Logs
  const statusLabels = ['Desconocido', 'Pendiente de Confirmación', 'Confirmado', 'En Producción', 'Listo para Entrega', 'Entregado', 'Cancelado'];
  const oldLabel = statusLabels[oldStatusId] || String(oldStatusId);
  const newLabel = statusLabels[statusId] || String(statusId);

  await createAuditLog(
    userName,
    `Estado de pedido actualizado - Pedido #${orderId}`,
    oldLabel,
    `${newLabel} (Comentario: ${comment || 'Ninguno'})`
  );
}

export async function getReportStats(): Promise<any> {
  const allOrders = await getOrders();
  const allTasks = await getProductionTasks(); // returns tasks for today usually, let's get all tasks in sandbox
  
  // In sandbox let's fetch all tasks
  let tasksList = mockDb.productionTasks;
  const pool = await getDbPool();
  if (pool) {
    try {
      const [rows]: any = await pool.query('SELECT * FROM production_tasks');
      tasksList = rows;
    } catch (err) {
      console.error('MySQL load tasks error:', err);
    }
  }

  // 1. Production Stats
  const totalTasks = tasksList.length;
  const completedTasks = tasksList.filter((t) => t.status_id === 3).length;
  const efficiency = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;

  // Delayed Tasks: started/due before today and not completed (status_id != 3)
  const todayStr = new Date().toISOString().split('T')[0];
  const delayedTasks = tasksList.filter((t) => t.start_date < todayStr && t.status_id !== 3).length;

  // 2. Finance Stats
  let paymentsList: any[] = [];
  let invoicesList: any[] = [];
  if (pool) {
    try {
      const [pRows]: any = await pool.query('SELECT * FROM payments');
      paymentsList = pRows;
      const [iRows]: any = await pool.query('SELECT * FROM invoices');
      invoicesList = iRows;
    } catch (err) {}
  } else {
    paymentsList = mockDb.payments;
    invoicesList = mockDb.invoices;
  }

  const totalRevenue = paymentsList.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  
  // Estimated revenue = sum of active orders total_price
  const activeOrders = allOrders.filter((o) => o.status_id !== 6); // non-cancelled
  const estimatedRevenue = activeOrders.reduce((sum, o) => sum + parseFloat(o.total_price as any), 0);

  // Pending payments
  const totalPaidPerOrder: Record<number, number> = {};
  paymentsList.forEach((p) => {
    totalPaidPerOrder[p.order_id] = (totalPaidPerOrder[p.order_id] || 0) + parseFloat(p.amount);
  });

  let pendingPayments = 0;
  activeOrders.forEach((o) => {
    const paid = totalPaidPerOrder[o.id] || 0;
    const balance = parseFloat(o.total_price as any) - paid;
    if (balance > 0.01) {
      pendingPayments += balance;
    }
  });

  // Profitability estimation per product
  const productProfitability = mockDb.products.map((p) => {
    // Estimating standard profit margins based on variants and base cost
    const markup = p.base_price * 0.4; // 40% estimated markup
    return {
      product_name: p.name,
      base_price: p.base_price,
      estimated_profit: markup,
      margin_percentage: 40
    };
  });

  // 3. Client Stats
  const clientSpent: Record<number, { name: string; count: number; spent: number }> = {};
  allOrders.forEach((o) => {
    if (!o.client_id) return;
    if (!clientSpent[o.client_id]) {
      clientSpent[o.client_id] = { name: o.client_name, count: 0, spent: 0 };
    }
    clientSpent[o.client_id].count += 1;
    clientSpent[o.client_id].spent += parseFloat(o.total_price as any);
  });

  const clientHistory = Object.entries(clientSpent).map(([id, data]) => ({
    client_id: parseInt(id, 10),
    client_name: data.name,
    order_count: data.count,
    total_spent: data.spent
  })).sort((a, b) => b.total_spent - a.total_spent);

  return {
    production: {
      totalTasks,
      completedTasks,
      efficiency,
      delayedTasks
    },
    finances: {
      totalRevenue,
      estimatedRevenue,
      pendingPayments,
      productProfitability,
      invoiceCount: invoicesList.length
    },
    clients: {
      clientHistory,
      purchaseFrequency: allOrders.length > 0 ? (allOrders.length / Math.max(1, clientHistory.length)).toFixed(1) : '0'
    }
  };
}

// 7. Workshop Supervisor Custom Operations (Advance & Rework)
export async function advanceTaskStage(
  taskId: number,
  userId: number,
  userName: string,
  comment?: string
): Promise<void> {
  return runWithRetry(async () => {
    const pool = await getDbPool();
    // Fetch the current task first
    let task: any;
    if (pool) {
      const [tasks]: any = await pool.query('SELECT * FROM production_tasks WHERE id = ?', [taskId]);
      if (tasks.length === 0) throw new Error('Task not found');
      task = tasks[0];
    } else {
      task = mockDb.productionTasks.find((t) => t.id === taskId);
      if (!task) throw new Error('Task not found');
    }

    const orderId = task.order_id;
    const currentStageId = task.stage_id;

    // Find all tasks for this order, sorted by stage_id
    let allTasks: any[] = [];
    if (pool) {
      const [rows]: any = await pool.query(
        'SELECT * FROM production_tasks WHERE order_id = ? ORDER BY stage_id ASC',
        [orderId]
      );
      allTasks = rows;
    } else {
      allTasks = mockDb.productionTasks
        .filter((t) => t.order_id === orderId)
        .sort((a, b) => a.stage_id - b.stage_id);
    }

    const currentIndex = allTasks.findIndex((t) => t.id === taskId);
    const nextTask = allTasks[currentIndex + 1];

    // We will complete the current task
    const todayStr = new Date().toISOString().split('T')[0];

    if (pool) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Complete current task
        await conn.query(
          `UPDATE production_tasks 
           SET status_id = 3, end_date_actual = ?, updated_at = NOW()
           WHERE id = ?`,
          [todayStr, taskId]
        );

        // Log in task history
        await conn.query(
          `INSERT INTO production_task_history (production_task_id, status_id, changed_by, comment)
           VALUES (?, 3, ?, ?)`,
          [taskId, userId, comment || 'Fase completada y avanzada por supervisor']
        );

        if (nextTask) {
          // Update next task to start today so it appears in Kanban visually!
          await conn.query(
            `UPDATE production_tasks 
             SET start_date = ?, updated_at = NOW()
             WHERE id = ?`,
            [todayStr, nextTask.id]
          );

          await conn.query(
            `INSERT INTO production_task_history (production_task_id, status_id, changed_by, comment)
             VALUES (?, ?, ?, ?)`,
            [nextTask.id, nextTask.status_id, userId, 'Fecha de inicio adelantada para visualización activa en taller']
          );
        } else {
          // If no next task, it was the last task. Mark the order as Listo para entrega (status_id = 4)
          await conn.query(
            'UPDATE orders SET status_id = 4, updated_at = NOW() WHERE id = ?',
            [orderId]
          );
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } else {
      // Sandbox
      task.status_id = 3;
      task.end_date_actual = todayStr;
      task.updated_at = new Date().toISOString();

      mockDb.productionTaskHistory.push({
        id: mockDb.productionTaskHistory.length + 1,
        production_task_id: taskId,
        status_id: 3,
        changed_by: userId,
        changed_at: new Date().toISOString(),
        comment: comment || 'Fase completada y avanzada por supervisor',
      });

      if (nextTask) {
        const nextT = mockDb.productionTasks.find((t) => t.id === nextTask.id);
        if (nextT) {
          nextT.start_date = todayStr;
          nextT.updated_at = new Date().toISOString();
          mockDb.productionTaskHistory.push({
            id: mockDb.productionTaskHistory.length + 1,
            production_task_id: nextT.id,
            status_id: nextT.status_id,
            changed_by: userId,
            changed_at: new Date().toISOString(),
            comment: 'Fecha de inicio adelantada para visualización activa en taller',
          });
        }
      } else {
        const ord = mockDb.orders.find((o) => o.id === orderId);
        if (ord) {
          ord.status_id = 4;
          ord.updated_at = new Date().toISOString();
        }
      }
    }

    // Create audit log
    const stageNames = [
      'Ninguno',
      'Corte',
      'Estampado',
      'Confeccionado',
      'Acabado',
      'Revisado',
      'Bordado',
      'Planchado',
      'Empaquetado',
      'Recibido en Tienda',
      'Despachado',
    ];
    const currentStageName = stageNames[currentStageId] || `Etapa ${currentStageId}`;
    const nextStageName = nextTask ? (stageNames[nextTask.stage_id] || `Etapa ${nextTask.stage_id}`) : 'Ninguna (Finalizado)';

    await createAuditLog(
      userName,
      `Pedido #${orderId} - Avanzado de Etapa`,
      currentStageName,
      `Completado -> Siguiente etapa: ${nextStageName}`
    );
  });
}

export async function getReworkEvents(orderId?: number): Promise<ReworkEvent[]> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS rework_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          production_task_id INT NOT NULL,
          order_id INT NOT NULL,
          rework_type VARCHAR(50) NOT NULL,
          description TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_by INT NOT NULL,
          stage_id INT NOT NULL
        )`
      );

      let sql = `
        SELECT re.*, 
               u.full_name as created_by_name,
               ps.name as stage_name
        FROM rework_events re
        JOIN users u ON re.created_by = u.id
        JOIN production_stages ps ON re.stage_id = ps.id
      `;
      const params: any[] = [];
      if (orderId) {
        sql += ' WHERE re.order_id = ?';
        params.push(orderId);
      }
      sql += ' ORDER BY re.created_at DESC';

      const [rows]: any = await pool.query(sql, params);
      return rows;
    } catch (err) {
      console.error('MySQL error in getReworkEvents:', err);
      return [];
    }
  } else {
    // Sandbox
    let list = mockDb.reworkEvents;
    if (orderId) {
      list = list.filter((r) => r.order_id === orderId);
    }
    return list.map((r) => {
      const u = mockDb.users.find((user) => user.id === r.created_by);
      const s = mockDb.productionStages.find((stg) => stg.id === r.stage_id);
      return {
        ...r,
        created_by_name: u?.full_name || 'Supervisor',
        stage_name: s?.name || `Etapa ${r.stage_id}`,
        created_at: r.created_at,
      };
    }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }
}

export async function createReworkEvent(
  taskId: number,
  reworkType: 'arreglo' | 'hacer_de_nuevo',
  description: string,
  userId: number,
  userName: string,
  targetStageId: number = 1
): Promise<number> {
  return runWithRetry(async () => {
    const pool = await getDbPool();
    
    // Get active task info
    let task: any;
    if (pool) {
      const [tasks]: any = await pool.query('SELECT * FROM production_tasks WHERE id = ?', [taskId]);
      if (tasks.length === 0) throw new Error('Task not found');
      task = tasks[0];
    } else {
      task = mockDb.productionTasks.find((t) => t.id === taskId);
      if (!task) throw new Error('Task not found');
    }

    const orderId = task.order_id;
    const originalStageId = task.stage_id;
    const todayStr = new Date().toISOString().split('T')[0];

    let insertedId = 0;

    if (pool) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Create table if not exists
        await conn.query(
          `CREATE TABLE IF NOT EXISTS rework_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            production_task_id INT NOT NULL,
            order_id INT NOT NULL,
            rework_type VARCHAR(50) NOT NULL,
            description TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_by INT NOT NULL,
            stage_id INT NOT NULL
          )`
        );

        // Insert event
        const [res]: any = await conn.query(
          `INSERT INTO rework_events (production_task_id, order_id, rework_type, description, created_by, stage_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [taskId, orderId, reworkType, description, userId, originalStageId]
        );
        insertedId = res.insertId;

        if (reworkType === 'arreglo') {
          // Set current task back to Pendiente (status_id = 1) and clear end_date_actual
          await conn.query(
            `UPDATE production_tasks 
             SET status_id = 1, end_date_actual = NULL, updated_at = NOW()
             WHERE id = ?`,
            [taskId]
          );

          // Add history
          await conn.query(
            `INSERT INTO production_task_history (production_task_id, status_id, changed_by, comment)
             VALUES (?, 1, ?, ?)`,
            [taskId, userId, `RETRABAJO (ARREGLO): ${description}`]
          );

        } else {
          // 'hacer_de_nuevo' - Reset from targetStageId up to originalStageId
          const [stagesToReset]: any = await conn.query(
            `SELECT * FROM production_tasks 
             WHERE order_id = ? AND stage_id >= ? AND stage_id <= ?
             ORDER BY stage_id ASC`,
            [orderId, targetStageId, originalStageId]
          );

          for (let i = 0; i < stagesToReset.length; i++) {
            const tToReset = stagesToReset[i];
            
            // Calculate start_date based on today + index
            const newStartDateObj = new Date();
            newStartDateObj.setDate(newStartDateObj.getDate() + i);
            const newStartDate = newStartDateObj.toISOString().split('T')[0];

            await conn.query(
              `UPDATE production_tasks 
               SET status_id = 1, end_date_actual = NULL, start_date = ?, updated_at = NOW()
               WHERE id = ?`,
              [newStartDate, tToReset.id]
            );

            await conn.query(
              `INSERT INTO production_task_history (production_task_id, status_id, changed_by, comment)
               VALUES (?, 1, ?, ?)`,
              [tToReset.id, userId, `RETRABAJO (HACER DE NUEVO - REINICIADO): ${description}`]
            );
          }
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } else {
      // Sandbox
      insertedId = mockDb.reworkEvents.length + 1;
      mockDb.reworkEvents.push({
        id: insertedId,
        production_task_id: taskId,
        order_id: orderId,
        rework_type: reworkType,
        description,
        created_at: new Date().toISOString(),
        created_by: userId,
        stage_id: originalStageId,
      });

      if (reworkType === 'arreglo') {
        task.status_id = 1;
        task.end_date_actual = undefined;
        task.updated_at = new Date().toISOString();

        mockDb.productionTaskHistory.push({
          id: mockDb.productionTaskHistory.length + 1,
          production_task_id: taskId,
          status_id: 1,
          changed_by: userId,
          changed_at: new Date().toISOString(),
          comment: `RETRABAJO (ARREGLO): ${description}`,
        });
      } else {
        // 'hacer_de_nuevo'
        const tasksToReset = mockDb.productionTasks
          .filter((t) => t.order_id === orderId && t.stage_id >= targetStageId && t.stage_id <= originalStageId)
          .sort((a, b) => a.stage_id - b.stage_id);

        tasksToReset.forEach((tToReset, i) => {
          const newStartDateObj = new Date();
          newStartDateObj.setDate(newStartDateObj.getDate() + i);
          const newStartDate = newStartDateObj.toISOString().split('T')[0];

          tToReset.status_id = 1;
          tToReset.end_date_actual = undefined;
          tToReset.start_date = newStartDate;
          tToReset.updated_at = new Date().toISOString();

          mockDb.productionTaskHistory.push({
            id: mockDb.productionTaskHistory.length + 1,
            production_task_id: tToReset.id,
            status_id: 1,
            changed_by: userId,
            changed_at: new Date().toISOString(),
            comment: `RETRABAJO (HACER DE NUEVO - REINICIADO): ${description}`,
          });
        });
      }
    }

    // Create audit logs
    const stageNames = [
      'Ninguno',
      'Corte',
      'Estampado',
      'Confeccionado',
      'Acabado',
      'Revisado',
      'Bordado',
      'Planchado',
      'Empaquetado',
      'Recibido en Tienda',
      'Despachado',
    ];
    const origStageName = stageNames[originalStageId] || `Etapa ${originalStageId}`;
    const targetStageName = stageNames[targetStageId] || `Etapa ${targetStageId}`;

    const detailLabel = reworkType === 'arreglo'
      ? `Evento de arreglo en la etapa actual (${origStageName}): "${description}"`
      : `Reiniciar producción desde ${targetStageName} hasta ${origStageName} debido a error: "${description}"`;

    await createAuditLog(
      userName,
      `Pedido #${orderId} - Evento de Retrabajo Registrado`,
      reworkType === 'arreglo' ? 'Arreglo de Etapa' : 'Empezar de Nuevo',
      detailLabel
    );

    return insertedId;
  });
}

export async function getAllUsers(): Promise<any[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query(
      'SELECT u.id, u.full_name, u.email, u.role_id, r.name as role_name, u.is_active FROM users u JOIN roles r ON u.role_id = r.id'
    );
    return rows;
  } else {
    return mockDb.users.map((u) => {
      const r = mockDb.roles.find((role) => role.id === u.role_id);
      return {
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        role_id: u.role_id,
        role_name: r ? r.name : 'cliente',
        is_active: u.is_active,
      };
    });
  }
}

export async function getAllRoles(): Promise<any[]> {
  const pool = await getDbPool();
  if (pool) {
    const [rows]: any = await pool.query('SELECT * FROM roles');
    return rows;
  } else {
    return mockDb.roles;
  }
}

export async function getRolePermissions(): Promise<any[]> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS role_permissions (
          role_id INT NOT NULL,
          permission_key VARCHAR(50) NOT NULL,
          is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          PRIMARY KEY (role_id, permission_key)
        )`
      );
      // Ensure seed permissions exist in MySQL as well
      const [rows]: any = await pool.query('SELECT * FROM role_permissions');
      if (rows.length === 0) {
        // Seed default permissions
        const defaultPerms = [
          [1, 'dashboard', 1], [1, 'calendar', 1], [1, 'create_order', 1], [1, 'kanban', 1], [1, 'admin_panel', 1], [1, 'my_orders', 0],
          [2, 'dashboard', 1], [2, 'calendar', 1], [2, 'create_order', 1], [2, 'kanban', 0], [2, 'admin_panel', 0], [2, 'my_orders', 0],
          [3, 'dashboard', 0], [3, 'calendar', 0], [3, 'create_order', 0], [3, 'kanban', 1], [3, 'admin_panel', 0], [3, 'my_orders', 0],
          [4, 'dashboard', 0], [4, 'calendar', 0], [4, 'create_order', 0], [4, 'kanban', 0], [4, 'admin_panel', 0], [4, 'my_orders', 1]
        ];
        for (const perm of defaultPerms) {
          await pool.query('INSERT IGNORE INTO role_permissions (role_id, permission_key, is_enabled) VALUES (?, ?, ?)', perm);
        }
        const [seededRows]: any = await pool.query('SELECT * FROM role_permissions');
        return seededRows;
      }
      return rows;
    } catch (err) {
      console.error('Failed to query or create role_permissions:', err);
      return [];
    }
  } else {
    return mockDb.rolePermissions;
  }
}

export async function updateRolePermission(roleId: number, permissionKey: string, isEnabled: boolean): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_key, is_enabled) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE is_enabled = ?`,
        [roleId, permissionKey, isEnabled, isEnabled]
      );
    } catch (err) {
      console.error('Failed to update role_permissions in MySQL:', err);
    }
  } else {
    const existing = mockDb.rolePermissions.find(
      (rp) => rp.role_id === roleId && rp.permission_key === permissionKey
    );
    if (existing) {
      existing.is_enabled = isEnabled;
    } else {
      mockDb.rolePermissions.push({
        role_id: roleId,
        permission_key: permissionKey,
        is_enabled: isEnabled
      });
    }
  }
}

export async function createUser(fullName: string, email: string, passwordHash: string, roleId: number, isActive: boolean): Promise<any> {
  const pool = await getDbPool();
  if (pool) {
    const [result]: any = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role_id, is_active) VALUES (?, ?, ?, ?, ?)',
      [fullName, email, passwordHash, roleId, isActive]
    );
    return { id: result.insertId, full_name: fullName, email, role_id: roleId, is_active: isActive };
  } else {
    const newId = mockDb.users.length + 1;
    const newUser = {
      id: newId,
      full_name: fullName,
      email,
      password_hash: passwordHash,
      role_id: roleId,
      is_active: isActive
    };
    mockDb.users.push(newUser);
    return newUser;
  }
}

export async function updateUserStatus(id: number, isActive: boolean): Promise<void> {
  const pool = await getDbPool();
  if (pool) {
    await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
  } else {
    const user = mockDb.users.find((u) => u.id === id);
    if (user) {
      user.is_active = isActive;
    } else {
      throw new Error('Usuario no encontrado');
    }
  }
}



