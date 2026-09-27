import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function PayrollPage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.payroll"
            endpoint="/api/proxy/hr/payroll"
            columns={[
                { key: 'employee_id', label: 'Employee ID' },
                { key: 'pay_period', label: 'Period' },
                { key: 'pay_date', label: 'Pay Date' },
                { key: 'gross_salary', label: 'Gross' },
                { key: 'deductions', label: 'Deductions' },
                { key: 'tax', label: 'Tax' },
                { key: 'net_salary', label: 'Net' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'employee_id', label: 'Employee ID', type: 'number' },
                { key: 'pay_period', label: 'Pay Period' },
                { key: 'pay_date', label: 'Pay Date', type: 'date' },
                { key: 'gross_salary', label: 'Gross Salary', type: 'number' },
                { key: 'deductions', label: 'Deductions', type: 'number' },
                { key: 'tax', label: 'Tax', type: 'number' },
                { key: 'net_salary', label: 'Net Salary', type: 'number' },
                { key: 'bonus', label: 'Bonus', type: 'number' },
                { key: 'currency', label: 'Currency' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['pending', 'processed', 'paid', 'cancelled']
                }
            ]}
        />
    );
}
